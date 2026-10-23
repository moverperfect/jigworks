import checkerWorker from "../generated/checker-worker.txt";
import { projectsOf, type CheckResult, type Problem, type Snapshot } from "./index";
import type { Checker } from "./worker";

/** A Check run in a Dynamic Worker. */
export interface IsolatedCheck extends CheckResult {
  filesSent: number;
}

const compatibilityDate = "2026-10-01";
// The Worker Loader reuses an isolate by ID, so the ID follows everything the
// isolate is made from: the bundle, which records ts-rust's hash (see
// scripts/pack-checker.mjs), and the compatibility date. A deploy that changes
// either gets a fresh isolate.
const workerId = `checker-${fnv1a(checkerWorker + compatibilityDate)}`;

/**
 * Type-checks a snapshot in a Dynamic Worker rather than the caller's isolate,
 * one call per tsconfig, so no two ts-rust runs share an isolate's memory
 * (ADR 0010). The snapshot should hold only what a Check reads: the
 * Workspace's files, and the Packages' type declarations and package.json
 * files. A crash in the checker comes back as a problem, not a throw.
 */
export async function checkInDynamicWorker(
  loader: WorkerLoader,
  tsRust: WebAssembly.Module,
  snapshot: Snapshot,
  projects = projectsOf(snapshot),
): Promise<IsolatedCheck> {
  const files = Object.fromEntries(snapshot);
  const worker = loader.get(workerId, async () => ({
    compatibilityDate,
    mainModule: "checker.js",
    modules: { "checker.js": checkerWorker, "ts_rust.wasm": { wasm: tsRust } },
    globalOutbound: null,
  }));
  const checker = worker.getEntrypoint<Checker>("Checker");

  const problems: Problem[] = [];
  for (const project of projects) {
    try {
      problems.push(...(await checker.check(files, [project])).problems);
    } catch (error) {
      problems.push({
        file: null,
        line: null,
        column: null,
        endLine: null,
        endColumn: null,
        code: 0,
        severity: "error",
        message: `The Check of ${project} crashed: ${error instanceof Error ? error.message : String(error)}`,
        project,
      });
    }
  }
  return { problems, projects, filesSent: snapshot.size };
}

/** A short, stable hash of a string. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}
