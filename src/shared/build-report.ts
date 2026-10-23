// What a Build reports, shared by the platform and its pages.

/** One error or warning from a Build, with its place when esbuild gives one: a Workspace path, and 1-based lines and columns. */
export interface BuildProblem {
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
}

/** The outcome of a Build, as the problems list shows it. The Build itself stays on the platform. */
export interface BuildReport {
  ranAt: string;
  ok: boolean;
  /** SHA-256 of the Build's inputs. */
  hash: string;
  /** Whether a recent Build of the same inputs was reused. */
  cached: boolean;
  errors: BuildProblem[];
  warnings: BuildProblem[];
}
