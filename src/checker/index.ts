import { memoryFileSystem, runTsc, type Diagnostic } from "ts-rust-wasm/core";
import type { Problem } from "../shared/check-report";
import { parseJsonc } from "../shared/jsonc";

export type { Problem };

/** A Workspace's files and Packages: path relative to the Workspace root, to text. */
export type Snapshot = ReadonlyMap<string, string>;

export interface CheckResult {
  problems: Problem[];
  /** The tsconfig files that were checked, in order. */
  projects: string[];
}

const root = "/workspace";
const severities = ["warning", "error", "suggestion", "message"] as const;

/**
 * Type-checks a snapshot with ts-rust. A root `tsconfig.json` with
 * `"files": []` and `references` (the solution style) checks each referenced
 * project in turn; otherwise the root project is checked. A crash in the
 * checker (a trap, or running out of stack or memory) throws.
 */
export function check(
  snapshot: Snapshot,
  module: WebAssembly.Module,
  options: { projects?: string[] } = {},
): CheckResult {
  const files = new Map<string, string>();
  for (const [path, text] of snapshot) files.set(`${root}/${path}`, text);
  const fs = memoryFileSystem(files);

  const projects = options.projects ?? projectsOf(snapshot);
  const problems: Problem[] = [];
  for (const project of projects) {
    const { diagnostics = [] } = runTsc(module, {
      args: ["-p", `${root}/${project}`, "--noEmit"],
      cwd: root,
      fs,
      diagnosticsJson: true,
    });
    for (const diagnostic of diagnostics) problems.push(toProblem(diagnostic, project));
  }
  return { problems, projects };
}

/** The tsconfig files a Check of this snapshot covers. */
export function projectsOf(snapshot: Snapshot): string[] {
  const config = parseJsonc(snapshot.get("tsconfig.json") ?? "") as
    | { files?: unknown[]; references?: { path?: string }[] }
    | undefined;
  const references = config?.references?.map((reference) => reference.path).filter((path) => typeof path === "string");
  if (config?.files?.length === 0 && references && references.length > 0) {
    return references.map((path) => {
      const relative = path.replace(/^\.\//, "");
      return relative.endsWith(".json") ? relative : `${relative.replace(/\/$/, "")}/tsconfig.json`;
    });
  }
  return ["tsconfig.json"];
}

function toProblem(diagnostic: Diagnostic, project: string): Problem {
  const start = diagnostic.startPosition;
  const end = diagnostic.endPosition;
  return {
    file: diagnostic.fileName?.startsWith(`${root}/`) ? diagnostic.fileName.slice(root.length + 1) : (diagnostic.fileName ?? null),
    line: start ? start.line + 1 : null,
    column: start ? start.character + 1 : null,
    endLine: end ? end.line + 1 : null,
    endColumn: end ? end.character + 1 : null,
    code: diagnostic.code,
    severity: severities[diagnostic.category],
    message: flatten(diagnostic),
    project,
  };
}

function flatten(diagnostic: Diagnostic, depth = 0): string {
  const lines = [`${"  ".repeat(depth)}${diagnostic.text}`];
  for (const next of diagnostic.messageChain ?? []) lines.push(flatten(next, depth + 1));
  return lines.join("\n");
}
