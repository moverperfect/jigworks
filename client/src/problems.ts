import type { BuildProblem, BuildReport } from "../../src/shared/build-report.ts";
import type { CheckReport, Problem, Severity } from "../../src/shared/check-report.ts";
import { failuresOf, testFailures, type TestReport } from "../../src/shared/test-report.ts";

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
 * found, its Package warnings and a failed install, the Build's errors and
 * warnings, then the tests' failures.
 */
export function countProblems(report: CheckReport | null, build: BuildReport | null, tests: TestReport | null): Record<Severity, number> {
  const counts = report ? { ...report.counts } : { error: 0, warning: 0, suggestion: 0, message: 0 };
  if (report) {
    counts.warning += report.packages.warnings.length;
    if (report.packages.state === "failed") counts.error += 1;
  }
  if (build) {
    counts.error += build.errors.length;
    counts.warning += build.warnings.length;
  }
  if (tests) counts.error += testFailures(tests);
  return counts;
}

/** The Build's errors, then its warnings, each with its severity for the list. */
export function buildProblems(build: BuildReport): PlacedProblem[] {
  return [
    ...build.errors.map((problem) => ({ ...problem, severity: "error" as const })),
    ...build.warnings.map((problem) => ({ ...problem, severity: "warning" as const })),
  ];
}

/** A problem at a place in a file, if it has one, such as the Build's and the tests'. `diff` is a failed comparison's. */
export interface PlacedProblem extends BuildProblem {
  severity: Severity;
  diff?: string | null;
}

/** Why the tests couldn't be bundled, then each test file's failures, at the place each failed, or where its test or file is. */
export function testProblems(report: TestReport): PlacedProblem[] {
  return [
    ...report.bundleErrors.map((problem) => ({ ...problem, severity: "error" as const })),
    ...report.files.flatMap((file) =>
      failuresOf(file).map(({ test, failure }) => ({
        severity: "error" as const,
        message: test ? `${test.name.join(" > ")}: ${failure.message}` : failure.message,
        diff: failure.diff,
        file: failure.file ?? file.file,
        line: failure.file ? failure.line : (test?.line ?? null),
        column: failure.file ? failure.column : null,
      })),
    ),
  ];
}

/** For example "3 passed, 1 failed", or "No tests". */
export function summariseTests({ files, counts, bundleErrors }: TestReport): string {
  if (bundleErrors.length > 0) return "The tests couldn't be bundled";
  if (files.length === 0) return "No tests";
  const parts = [`${counts.passed} passed`, `${counts.failed} failed`];
  if (counts.skipped + counts.todo > 0) parts.push(`${counts.skipped + counts.todo} skipped`);
  return parts.join(", ");
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
