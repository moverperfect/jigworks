/** Where a Workspace's Deployment answers, and what it runs, for the Workspace page. */
export interface Deployment {
  url: string;
  /** ISO 8601, or null before the first publish. */
  publishedAt: string | null;
  /** The hash of the Build it runs, or null before the first publish. */
  hash: string | null;
}
