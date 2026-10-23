import type { BuildProblem, BuildReport } from "../../src/shared/build-report.ts";
import type { CheckReport, Problem, Severity } from "../../src/shared/check-report.ts";

/** One file's problems. Problems with no file are under their tsconfig. */
export interface FileProblems {
  path: string;
  problems: Problem[];
}

/** The file a problem belongs to: a problem with no file belongs to its tsconfig. */
export const problemPath = (problem: Problem): string => problem.file ?? problem.project;

const collator = new Intl.Collator(undefined, { numeric: true });

/** Problems grouped by file, files in path order, and each file's problems in line order. */
export function groupProblems(problems: readonly Problem[]): FileProblems[] {
  const groups = new Map<string, Problem[]>();
  for (const problem of problems) {
    const path = problemPath(problem);
    const group = groups.get(path);
    if (group) group.push(problem);
    else groups.set(path, [problem]);
  }
  return [...groups]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([path, list]) => ({
      path,
      problems: list.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)),
    }));
}

/** How many problems the Check found in all, including any the report left out. */
export const problemTotal = (report: CheckReport): number =>
  Object.values(report.counts).reduce((total, count) => total + count, 0);

/**
 * How many of each severity the problems list shows: every problem the Check
 * found, its Package warnings and a failed install, then the Build's errors
 * and warnings.
 */
export function countProblems(report: CheckReport | null, build: BuildReport | null): Record<Severity, number> {
  const counts = report ? { ...report.counts } : { error: 0, warning: 0, suggestion: 0, message: 0 };
  if (report) {
    counts.warning += report.packages.warnings.length;
    if (report.packages.state === "failed") counts.error += 1;
  }
  if (build) {
    counts.error += build.errors.length;
    counts.warning += build.warnings.length;
  }
  return counts;
}

/** An error or warning from a Build, with the place it's about if it gave one. */
/** The Build's errors, then its warnings, each with its severity for the list. */
export function buildProblems(build: BuildReport): (BuildProblem & { severity: Severity })[] {
  return [
    ...build.errors.map((problem) => ({ ...problem, severity: "error" as const })),
    ...build.warnings.map((problem) => ({ ...problem, severity: "warning" as const })),
  ];
}

const severities: Severity[] = ["error", "warning", "suggestion", "message"];

/** For example "2 errors, 1 warning", or "No problems". */
export function summarise(counts: Record<Severity, number>): string {
  const parts = severities
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}${counts[severity] === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "No problems";
}

/** Where a problem is, as `file:line:column`. */
export function problemLocation(problem: Problem): string {
  return [problemPath(problem), problem.line, problem.column].filter((part) => part !== null).join(":");
}
