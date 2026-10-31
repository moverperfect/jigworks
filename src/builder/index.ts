import { createApp, createWorker, type Modules } from "@cloudflare/worker-bundler";
import { init as initLexer, parse } from "es-module-lexer/js";
import type { BuildProblem } from "../shared/build-report";
import { parseJsonc } from "../shared/jsonc";
import { platformEnvPrefix } from "../apphost/app-data";
import { bundlerFiles, esbuildProblems, missingImports, unplaced, type Snapshot } from "./bundling";
import { frontEnd, tailwindVersion, type TailwindFailure } from "./front-end";

export type { BuildProblem, Snapshot };

/** The `assets` settings in `wrangler.jsonc` the app host follows (ADR 0014). */
export interface AssetSettings {
  notFoundHandling: "single-page-application" | "none";
  /** True, or path patterns such as `/api/*`; a pattern starting `!` excludes. */
  runWorkerFirst: boolean | string[];
}

export interface Build {
  ok: true;
  /** SHA-256 of the inputs, usable as a cache key and a Dynamic Worker ID. */
  hash: string;
  mainModule: string;
  modules: Modules;
  compatibilityDate: string | undefined;
  compatibilityFlags: string[];
  /** Plain-text `vars` from `wrangler.jsonc`. */
  vars: Record<string, string>;
  /** Pathname to content, which the app host serves in front of the Worker. Empty without a front end. */
  assets: Record<string, string>;
  /** Pathname to each asset's content type, if the bundler knows it, and ETag. */
  assetManifest: Record<string, { contentType?: string; etag: string }>;
  assetSettings: AssetSettings;
  /** How many possible class names the Tailwind step was given, if it ran. */
  tailwindCandidates?: number;
  /** Each Durable Object binding in `wrangler.jsonc`, to the class it binds (ADR 0006). */
  durableObjects: Record<string, string>;
  warnings: BuildProblem[];
}

export interface BuildFailure {
  ok: false;
  hash: string;
  errors: BuildProblem[];
  warnings: BuildProblem[];
  /** Packages the output still imports, which the bundler leaves in place without a word. Counted for the findings. */
  missingPackages: string[];
  /** Why the Tailwind step failed, if it did, counted for the findings. */
  tailwindFailure?: TailwindFailure;
}

export type BuildResult = Build | BuildFailure;

/**
 * What the Workspace builds with. It runs in the Workspace's own isolate for
 * now; a Dynamic Worker could provide it instead if memory runs short
 * (ADR 0010).
 */
export interface Builder {
  /** Builds, or reuses a recent Build of the same inputs. */
  build(snapshot: Snapshot): Promise<BuildResult & { cached: boolean }>;
}

// Enough to go back and forth between two versions without rebuilding. The
// app host keeps Builds for good (ADR 0009).
const cachedBuilds = 4;

/** A Builder in this isolate, which keeps its last few Builds by their inputs' hash. */
export function inProcessBuilder(): Builder {
  const recent = new Map<string, BuildResult>();
  return {
    async build(snapshot) {
      const hash = await hashOf(snapshot);
      const cached = recent.get(hash);
      if (cached) {
        recent.delete(hash);
        recent.set(hash, cached);
        return { ...cached, cached: true };
      }
      const result = await build(snapshot);
      recent.set(hash, result);
      if (recent.size > cachedBuilds) recent.delete(recent.keys().next().value!);
      return { ...result, cached: false };
    },
  };
}

/**
 * Builds a snapshot with `@cloudflare/worker-bundler`, unmodified. Every
 * Package must already be in the snapshot under `node_modules/`. A Build
 * fails if its output still imports a package the bundler couldn't find,
 * because the bundler otherwise leaves those imports in place without a word.
 * With an `index.html`, the Build has a front end too (see `front-end.ts`).
 */
export async function build(snapshot: Snapshot): Promise<BuildResult> {
  const hash = await hashOf(snapshot);
  const files = bundlerFiles(snapshot);
  const config = (parseJsonc(snapshot.get("wrangler.jsonc") ?? "{}") ?? {}) as {
    compatibility_date?: string;
    compatibility_flags?: string[];
    vars?: Record<string, unknown>;
    assets?: WranglerAssets;
    main?: string;
  };
  // The bindings' problems come with any others, so the Agent sees them all at once.
  const bindings = wranglerBindings(config);
  const fail = (errors: BuildProblem[], more: Partial<BuildFailure> = {}): BuildFailure => ({
    ok: false,
    hash,
    warnings: [],
    missingPackages: [],
    ...more,
    errors: [...bindings.problems, ...errors],
  });

  let mainModule: string;
  let modules: Modules;
  let warningTexts: string[];
  let assets: Record<string, string> = {};
  let assetManifest: Build["assetManifest"] = {};
  let clientBundles: string[] = [];
  let tailwindCandidates: number | undefined;
  try {
    if (snapshot.has("index.html")) {
      const front = await frontEnd(snapshot);
      if (!front.ok) {
        return fail(front.problems, { tailwindFailure: front.tailwindFailure });
      }
      const app = await createApp({
        files,
        client: front.entries,
        assets: { ...publicAssets(snapshot), "/index.html": front.html, ...front.compiled },
        jsx: "automatic",
        jsxImportSource: "react",
        minify: true,
      });
      ({ mainModule, modules } = app);
      // Only text goes in: the Workspace's files and the bundler's output.
      assets = app.assets as Record<string, string>;
      assetManifest = Object.fromEntries(app.assetManifest);
      warningTexts = app.warnings ?? [];
      clientBundles = (app.clientBundles ?? []).filter((path) => !path.endsWith(".css"));
      tailwindCandidates = front.tailwindCandidates;
    } else {
      const worker = await createWorker({ files });
      ({ mainModule, modules } = worker);
      warningTexts = worker.warnings ?? [];
    }
  } catch (error) {
    return fail(esbuildProblems(error));
  }
  const warnings = warningTexts.map(unplaced);

  await initLexer();
  const missing = [
    ...Object.entries(modules).flatMap(([name, module]) =>
      missingImports(typeof module === "string" ? module : (module.js ?? "")).map((specifier) => ({ name, specifier })),
    ),
    ...clientBundles.flatMap((path) => {
      const code = assets[path.startsWith("/") ? path : `/${path}`];
      return typeof code === "string" ? missingImports(code, { browser: true }).map((specifier) => ({ name: path, specifier })) : [];
    }),
  ];
  if (missing.length > 0) {
    return fail(
      missing.map(({ name, specifier }) => unplaced(`${name} imports "${specifier}", which isn't in the Workspace's Packages`)),
      { warnings, missingPackages: [...new Set(missing.map(({ specifier }) => specifier))] },
    );
  }
  const main = modules[mainModule];
  const exported = new Set(parse(typeof main === "string" ? main : (main?.js ?? ""))[1].map((name) => ("name" in name ? name.name : "")));
  const unexported = Object.entries(bindings.durableObjects).filter(([, className]) => !exported.has(className));
  if (unexported.length > 0 || bindings.problems.length > 0) {
    return fail(
      unexported.map(([binding, className]) => ({
        message: `${config.main ?? "The Worker"} doesn't export the class "${className}" that ${binding} binds to.`,
        ...inWrangler,
      })),
      { warnings },
    );
  }
  return {
    ok: true,
    hash,
    mainModule,
    modules,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    vars: Object.fromEntries(
      Object.entries(config.vars ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    assets,
    assetManifest,
    assetSettings: assetSettings(config.assets),
    durableObjects: bindings.durableObjects,
    tailwindCandidates,
    warnings,
  };
}

type WranglerAssets = { not_found_handling?: unknown; run_worker_first?: unknown };

// What `wrangler.jsonc` can ask for that the platform doesn't have: apps get
// Durable Objects and nothing else (ADR 0006). Each is a list in the config.
const unsupported: { key: string; lists: (config: Record<string, unknown>) => unknown[]; isNot: string }[] = [
  { key: "kv_namespaces", lists: (config) => [config.kv_namespaces], isNot: "KV isn't" },
  { key: "d1_databases", lists: (config) => [config.d1_databases], isNot: "D1 isn't" },
  { key: "r2_buckets", lists: (config) => [config.r2_buckets], isNot: "R2 isn't" },
  {
    key: "queues",
    lists: (config) => {
      const queues = config.queues as { producers?: unknown; consumers?: unknown } | undefined;
      return [queues?.producers, queues?.consumers];
    },
    isNot: "queues aren't",
  },
  { key: "triggers.crons", lists: (config) => [(config.triggers as { crons?: unknown } | undefined)?.crons], isNot: "cron triggers aren't" },
];

const inWrangler = { file: "wrangler.jsonc", line: null, column: null };
const jsName = /^[A-Za-z_$][\w$]*$/;

/**
 * The bindings `wrangler.jsonc` asks for: each Durable Object binding, to
 * the class it binds, and the problems with the rest. Those are anything the
 * platform doesn't have, and Durable Objects it can't run.
 */
function wranglerBindings(config: Record<string, unknown>): { durableObjects: Record<string, string>; problems: BuildProblem[] } {
  const problems: BuildProblem[] = unsupported
    .filter(({ lists }) => lists(config).some((list) => Array.isArray(list) && list.length > 0))
    .map(({ key, isNot }) => ({
      message: `${key} in wrangler.jsonc: ${isNot} available here. Apps get Durable Objects and nothing else.`,
      ...inWrangler,
    }));
  const durableObjects: Record<string, string> = {};
  const declared = (config.durable_objects as { bindings?: unknown } | undefined)?.bindings;
  if (declared !== undefined && !Array.isArray(declared)) {
    problems.push({ message: "durable_objects.bindings in wrangler.jsonc must be a list of Durable Object bindings.", ...inWrangler });
  }
  for (const binding of Array.isArray(declared) ? (declared as unknown[]) : []) {
    const { name, class_name: className, script_name: scriptName } = (binding ?? {}) as Record<string, unknown>;
    if (typeof scriptName === "string" && scriptName !== "") {
      problems.push({
        message: `${String(name)}'s class is in another Worker ("${scriptName}"). An app's Durable Objects must be its own classes.`,
        ...inWrangler,
      });
    } else if (
      typeof name !== "string" ||
      typeof className !== "string" ||
      !jsName.test(name) ||
      !jsName.test(className) ||
      // Not a key a plain object can hold, nor the platform's own, nor the app's default export.
      name === "__proto__" ||
      name.startsWith(platformEnvPrefix) ||
      className === "default"
    ) {
      problems.push({
        message: `A Durable Object binding in wrangler.jsonc needs a name and a class_name, each a JavaScript name: ${JSON.stringify(binding)}.`,
        ...inWrangler,
      });
    } else {
      durableObjects[name] = className;
    }
  }
  return { durableObjects, problems };
}

/** Each file under `public/`, at its path below it. */
function publicAssets(snapshot: Snapshot): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const [path, text] of snapshot) if (path.startsWith("public/")) assets[`/${path.slice("public/".length)}`] = text;
  return assets;
}

/** `assets` from `wrangler.jsonc`, with Cloudflare's defaults. Anything the app host can't do is left at its default. */
function assetSettings(assets: WranglerAssets = {}): AssetSettings {
  const first = assets.run_worker_first;
  return {
    notFoundHandling: assets.not_found_handling === "single-page-application" ? "single-page-application" : "none",
    runWorkerFirst:
      typeof first === "boolean" ? first : Array.isArray(first) ? first.filter((pattern) => typeof pattern === "string") : false,
  };
}

async function hashOf(snapshot: Snapshot): Promise<string> {
  const encoder = new TextEncoder();
  // The same files make a different Build after a Tailwind upgrade.
  const parts = [`tailwindcss ${tailwindVersion}`];
  for (const path of [...snapshot.keys()].sort()) parts.push(path, snapshot.get(path)!);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("\0")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
