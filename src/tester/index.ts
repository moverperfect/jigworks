import testerWorker from "../generated/tester-worker.txt";
import packedTypes from "../generated/vitest-types.txt";
import type { TestBundle } from "../builder";
import type { TestFileReport } from "../shared/test-report";
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
// Used when an app's wrangler.jsonc has no compatibility date, as for the app host.
const fallbackCompatibilityDate = "2026-10-01";
// Limits on each test file, as on the app's own code. Tests have no network.
const fileLimits = { cpuMs: 10_000, subRequests: 50 };
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
    const worker = loader.load({
      compatibilityDate: bundle.compatibilityDate ?? fallbackCompatibilityDate,
      compatibilityFlags: bundle.compatibilityFlags,
      mainModule: testerModule,
      modules: { [testerModule]: testerWorker, [testsModule]: bundle.code, [sourceMapModule]: { text: bundle.sourceMap } },
      globalOutbound: null,
      limits: fileLimits,
    });
    try {
      reports.push(await withTimeout(worker.getEntrypoint<Tester>("Tester").run(file), fileTimeoutMs));
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

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  const timeout = scheduler.wait(ms).then(() => {
    throw new Error(`it ran for more than ${ms / 1000} seconds.`);
  });
  return Promise.race([work, timeout]);
}
