// The copy of esbuild's compiled module that Builds use, for the Test bundler.
import esbuildWasm from "../../node_modules/@cloudflare/worker-bundler/dist/esbuild.wasm";
import testBundlerWorker from "../generated/test-bundler.txt";
import testerWorker from "../generated/tester-worker.txt";
import packedTypes from "../generated/vitest-types.txt";
import { appLimits, beforeDeadline, fallbackCompatibilityDate } from "../apphost";
import type { Snapshot } from "../builder";
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

/**
 * Bundles a snapshot's test files in a new Dynamic Worker (ADR 0017), so
 * esbuild's memory never reaches the caller's isolate. A bundler that fails,
 * as one that goes over its memory limit does, comes back as an error.
 */
export async function bundleTestsInDynamicWorker(loader: WorkerLoader, snapshot: Snapshot, testFiles: string[]): Promise<TestBundleResult> {
  try {
    const worker = loader.load({
      compatibilityDate: fallbackCompatibilityDate,
      mainModule: bundlerModule,
      modules: { [bundlerModule]: testBundlerWorker, "esbuild.wasm": { wasm: esbuildWasm } },
      globalOutbound: null,
    });
    return await worker.getEntrypoint<TestBundler>("TestBundler").bundle(Object.fromEntries(snapshot), testFiles, { vitest: vitestModule });
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
