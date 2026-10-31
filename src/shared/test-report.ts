// What a test run reports, shared by the platform and its pages.
import type { BuildProblem } from "./build-report";

/** Why a test, or a test file, failed, at the place in the Workspace's files it failed if a stack frame is in one. */
export interface TestFailure {
  message: string;
  /** Expected against received, for a failed comparison. */
  diff: string | null;
  file: string | null;
  /** From 1. */
  line: number | null;
  column: number | null;
}

/** One test, named after the describe blocks it's in: ["notes", "lists them"]. */
export interface TestCase {
  name: string[];
  state: "passed" | "failed" | "skipped" | "todo";
  /** Where the test is declared, from 1, if it could be found. */
  line: number | null;
  failure: TestFailure | null;
}

export interface TestFileReport {
  /** The Workspace path. */
  file: string;
  tests: TestCase[];
  /**
   * Failures outside any one test: the file wouldn't load, a describe block
   * or a hook threw, or the run went over its limits.
   */
  errors: TestFailure[];
  /** What the tests wrote to the console, cut short. */
  console: string[];
}

export type TestCounts = Record<TestCase["state"], number>;

/** The outcome of a test run, as the problems list shows it. */
export interface TestReport {
  ranAt: string;
  /** Each test file run, in path order. */
  files: TestFileReport[];
  /** Why the tests couldn't be bundled. Nothing ran if there are any. */
  bundleErrors: BuildProblem[];
  counts: TestCounts;
}

/** A file's failures: its errors outside any test, with no test, then its failed tests'. */
export function failuresOf(file: TestFileReport): { test: TestCase | null; failure: TestFailure }[] {
  return [
    ...file.errors.map((failure) => ({ test: null, failure })),
    ...file.tests.flatMap((test) => (test.state === "failed" && test.failure ? [{ test, failure: test.failure }] : [])),
  ];
}

/** How many failures a report has: failed tests, errors outside tests, and bundling errors. */
export const testFailures = (report: TestReport): number =>
  report.counts.failed + report.bundleErrors.length + report.files.reduce((total, file) => total + file.errors.length, 0);
