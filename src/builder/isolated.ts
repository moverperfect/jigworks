import builderWorker from "../generated/builder-worker.txt";
import { beforeDeadline } from "../apphost";
import { fnv1a } from "../checker/isolated";
import { bundledStream, unplaced, type FileSource } from "./bundling";
import { hashOf } from "./hash";
import type { BuildFailure, BuildResult, Builder, MadeBuild } from "./index";
import type { Builder as BuilderEntrypoint } from "./worker";

const builderModule = "builder.js";
const compatibilityDate = "2026-10-01";
// One Builder, reused, so esbuild starts once per isolate, as for the Checker
// and the Test bundler. The ID follows the Builder's code, which records
// esbuild's module's hash (see scripts/pack-tester.mjs), so a deploy that
// changes either gets a new isolate.
const workerId = `builder-${fnv1a(builderWorker + compatibilityDate)}`;
// The caller holds the Workspace's lock while it builds, so a Builder that
// never answers mustn't hold it for good.
const buildTimeoutMs = 60_000;

/**
 * Builds in a Dynamic Worker, so esbuild's memory, which it never gives back,
 * stays out of the caller's isolate (ADR 0010). Only the files a bundle takes
 * in are sent, as a stream, read as it goes. A Builder that fails, as one
 * that goes over its memory limit does, gives a failed Build, and Cloudflare
 * starts a new isolate for the next.
 */
export function isolatedBuilder(loader: WorkerLoader, timeoutMs = buildTimeoutMs): Builder {
  return cachingBuilder(async (files, hash) => {
    const worker = loader.get(workerId, async () => ({
      compatibilityDate,
      mainModule: builderModule,
      modules: {
        [builderModule]: builderWorker,
        // The copy of esbuild's module the Test bundler is given too.
        "esbuild.wasm": { wasm: (await import("../../node_modules/@cloudflare/worker-bundler/dist/esbuild.wasm")).default },
      },
      globalOutbound: null,
    }));
    // deferred: the Build comes back as one RPC result, held to 32 MiB, so images and fonts in public/ past about 30 MB fail the Build; send assets back as a stream if apps need more.
    const made = await beforeDeadline(worker.getEntrypoint<BuilderEntrypoint>("Builder").build(bundledStream(files), hash), Date.now() + timeoutMs);
    if (!made) throw new Error(`it took more than ${timeoutMs / 1000} seconds.`);
    return made;
  });
}

// Enough to go back and forth between two versions without rebuilding. The
// app host keeps Builds for good (ADR 0009).
const cachedBuilds = 4;

/**
 * The Build's error when the Builder's isolate goes over its memory limit,
 * which only a smaller app avoids (#99, docs/findings.md). The page shows it
 * as it is, so it's in the page's words (ADR 0018).
 */
export const tooBigToBuild = "Your app has grown too big to build here. Try removing a ready-made part.";
// Cloudflare's words for it, as the Builder's call fails.
const overMemory = /exceeded (its )?memory limit/i;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A Builder that keeps its last few Builds by their inputs' hash, and has
 * `make` make the rest. A `make` that throws, as one whose isolate went over
 * its memory limit twice does, gives a failed Build that isn't kept, so the
 * next try makes it again.
 */
export function cachingBuilder(make: (files: FileSource, hash: string) => Promise<MadeBuild>): Builder {
  const recent = new Map<string, BuildResult>();
  return {
    async build(files) {
      const hash = await hashOf(files);
      const cached = recent.get(hash);
      if (cached) {
        recent.delete(hash);
        recent.set(hash, cached);
        return { result: cached, wasmMemoryBytes: {}, receivingMs: null, cached: true };
      }
      let made: MadeBuild;
      try {
        // Cloudflare starts a new isolate after one goes over its memory limit, which
        // earlier Builds' memory or another Workspace's Build there may have caused, so
        // the app is too big only if it fails there too.
        made = await make(files, hash).catch((error: unknown) => (overMemory.test(reasonOf(error)) ? make(files, hash) : Promise.reject(error)));
      } catch (error) {
        const reason = reasonOf(error);
        const message = overMemory.test(reason) ? tooBigToBuild : `The Build couldn't run: ${reason}`;
        const result: BuildFailure = { ok: false, hash, errors: [unplaced(message)], warnings: [], missingPackages: [] };
        return { result, wasmMemoryBytes: {}, receivingMs: null, cached: false };
      }
      recent.set(hash, made.result);
      if (recent.size > cachedBuilds) recent.delete(recent.keys().next().value!);
      return { ...made, cached: false };
    },
  };
}
