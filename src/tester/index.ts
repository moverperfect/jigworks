import testBundlerWorker from "../generated/test-bundler.txt";
import testerWorker from "../generated/tester-worker.txt";
import packedTypes from "../generated/vitest-types.txt";
import { appLimits, beforeDeadline, fallbackCompatibilityDate } from "../apphost";
import type { FileSource } from "../builder";
import { bundledStream } from "../builder/bundling";
import { fnv1a } from "../checker/isolated";
import type { TestBundle, TestBundleResult } from "../builder/tests";
import type { TestFileReport } from "../shared/test-report";
import type { TestBundler } from "./bundler";
import { sourceMapModule, testsModule, vitestGlobal } from "./names";
import type { Tester } from "./worker";

/** Whether a Workspace path is a test file, as vitest's default `include` finds them. */
export const isTestFile = (path: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith("node_modules/");

/** The `vitest` module the tests are bundled with, which hands them the Tester's own (see runtime.ts). */
export const vitestModule = `const vitest = globalThis[Symbol.for(${JSON.stringify(vitestGlobal)})];
export const { describe, suite, it, test, beforeAll, afterAll, beforeEach, afterEach, aroundAll, aroundEach, onTestFailed, onTestFinished, expect, assert, vi } = vitest;
export { vi as vitest };
`;

let types: Map<string, string> | null = null;

/** The declarations of the platform's `vitest`, by their paths under node_modules/, for the Check. */
export const vitestTypes = (): Map<string, string> =>
  (types ??= new Map(Object.entries(JSON.parse(packedTypes) as Record<string, string>)));

const testerModule = "tester.js";
const bundlerModule = "bundler.js";
const bundlerCompatibilityDate = "2026-10-01";
// One bundler, reused, so esbuild starts once per isolate, as the Checker
// does. The ID follows the bundler's code, which records esbuild's module's
// hash (see scripts/pack-tester.mjs), so a deploy that changes either gets a
// new isolate.
const bundlerId = `test-bundler-${fnv1a(testBundlerWorker + bundlerCompatibilityDate)}`;
// The caller holds the Workspace's lock while the tests bundle, so a bundler
// that never answers mustn't hold it for good.
const bundleTimeoutMs = 60_000;

/**
 * Bundles the test files in a Dynamic Worker (ADR 0017), so esbuild's
 * memory never reaches the caller's isolate. The files go as a Build's do, as
 * a stream, read as it goes (see `bundledStream`). A bundler that fails,
 * as one that goes over its memory limit does, comes back as an error, and
 * Cloudflare starts a new isolate for the next call.
 */
export async function bundleTestsInDynamicWorker(
  loader: WorkerLoader,
  files: FileSource,
  testFiles: string[],
  timeoutMs = bundleTimeoutMs,
): Promise<TestBundleResult> {
  try {
    const worker = loader.get(bundlerId, async () => ({
      compatibilityDate: bundlerCompatibilityDate,
      mainModule: bundlerModule,
      modules: {
        [bundlerModule]: testBundlerWorker,
        // The copy of esbuild's module that Builds use. Imported only when
        // needed, as worker-bundler does, because an isolate compiles a wasm
        // module it imports as it starts.
        "esbuild.wasm": { wasm: (await import("../../node_modules/@cloudflare/worker-bundler/dist/esbuild.wasm")).default },
      },
      globalOutbound: null,
    }));
    const bundled: Promise<TestBundleResult> = worker.getEntrypoint<TestBundler>("TestBundler").bundle(bundledStream(files), testFiles, { vitest: vitestModule });
    const result = await beforeDeadline(bundled, Date.now() + timeoutMs);
    if (!result) throw new Error(`it took more than ${timeoutMs / 1000} seconds.`);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ message: `The tests couldn't be bundled: ${reason}`, file: null, line: null, column: null }] };
  }
}

// Each test has its own timeout (5 s), so a file this slow is stuck elsewhere.
const fileTimeoutMs = 60_000;

/**
 * Runs each test file in a Dynamic Worker of its own (ADR 0017), one after
 * another, and reports each. A file that fails to finish, because it went
 * over its limits or crashed the isolate, is reported as an error.
 */
export async function testInDynamicWorkers(loader: WorkerLoader, bundle: TestBundle, files: string[]): Promise<TestFileReport[]> {
  const reports: TestFileReport[] = [];
  for (const file of files) {
    try {
      // Loading fails at once for a compatibility flag workerd doesn't know.
      const worker = loader.load({
        compatibilityDate: bundle.compatibilityDate ?? fallbackCompatibilityDate,
        compatibilityFlags: bundle.compatibilityFlags,
        mainModule: testerModule,
        modules: { [testerModule]: testerWorker, [testsModule]: bundle.code, [sourceMapModule]: { text: bundle.sourceMap } },
        // The app's own limits, and no network.
        globalOutbound: null,
        limits: appLimits,
      });
      const report = await beforeDeadline(worker.getEntrypoint<Tester>("Tester").run(file), Date.now() + fileTimeoutMs);
      if (!report) throw new Error(`it ran for more than ${fileTimeoutMs / 1000} seconds.`);
      reports.push(report);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reports.push({
        file,
        tests: [],
        errors: [{ message: `The test file didn't finish: ${reason}`, diff: null, file: null, line: null, column: null }],
        console: [],
      });
    }
  }
  return reports;
}
