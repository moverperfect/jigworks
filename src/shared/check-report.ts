// What a Check reports, shared by the platform and its pages.

export type Severity = "error" | "warning" | "suggestion" | "message";

/** One error or warning from a Check, with 1-based lines and UTF-16 columns. */
export interface Problem {
  /** The Workspace path, or null for a problem with no file (a bad option). */
  file: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  /** The TypeScript code, for example 2322. 0 for a crash of the checker itself. */
  code: number;
  severity: Severity;
  message: string;
  /** The tsconfig the problem came from. */
  project: string;
}

/** What's installed in a Workspace, and how the last install went. */
export interface PackageStatus {
  state: "none" | "installed" | "failed";
  /** The installed Packages, sorted by name. */
  packages: { name: string; version: string }[];
  warnings: string[];
  error: string | null;
}

/** The outcome of a Check, as the problems list shows it. */
export interface CheckReport {
  ranAt: string;
  /** The tsconfig files checked. */
  projects: string[];
  /** The first problems found, as many as fit in the report. */
  problems: Problem[];
  /** How many problems of each severity there were in all, kept or not. */
  counts: Record<Severity, number>;
  /** The Packages the Check ran against, and the last install's warnings. */
  packages: PackageStatus;
}
