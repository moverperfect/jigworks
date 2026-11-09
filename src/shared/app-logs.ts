// An app's logs, as the platform and its pages share them.

/** Which of an app's two faces a request is for: the Preview, or the Deployment (ticket 10). */
export type Slot = "preview" | "deployment";

/** One line in an app's logs: from its Worker, or from a browser running its pages. */
export interface AppLogEntry {
  /** ISO 8601. */
  at: string;
  slot: Slot;
  source: "server" | "browser";
  /** Such as `log`, `warn`, `exception` or `unhandledrejection`. */
  level: string;
  message: string;
}

/**
 * The Build the Preview runs, or null before it has one, and its errors and
 * warnings since it took it, or since its Secrets last changed, for the page (#104).
 */
export interface PreviewProblems {
  hash: string | null;
  problems: AppLogEntry[];
}

/** Whether a log line is a warning, rather than an error, among the Preview's problems (see `AppHost.problemsSince`). */
export const isWarning = (entry: AppLogEntry) => entry.level === "warn";
