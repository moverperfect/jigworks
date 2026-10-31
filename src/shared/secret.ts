/** A Workspace's secret, by name: its value never leaves the app host (ADR 0016). */
export interface Secret {
  name: string;
  /** ISO 8601. */
  updatedAt: string;
}
