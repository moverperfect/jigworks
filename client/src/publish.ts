import type { BuildReport } from "../../src/shared/build-report.ts";

/**
 * What people with the app's link see, in the page's words (ADR 0018):
 * - `not-published`: there's no Deployment, so only the Developer sees the app;
 * - `live`: the Deployment runs the latest successful Build;
 * - `live-with-changes`: the Deployment runs an earlier Build.
 */
export type PublishState = "not-published" | "live" | "live-with-changes";

/**
 * The publish state, from the hash of the Build the Deployment runs (null
 * before the first publish) and the hash of the latest successful Build (null
 * when the page knows of none), which is the Build the Preview runs and
 * Publish copies. Null when the page can't tell: a Build was published, so
 * one succeeded, but the page doesn't know the latest yet.
 */
export function publishState(deployedHash: string | null, latestGoodHash: string | null): PublishState | null {
  if (deployedHash === null) return "not-published";
  if (latestGoodHash === null) return null;
  return latestGoodHash === deployedHash ? "live" : "live-with-changes";
}

/**
 * The latest successful Build's hash, after the page sees `build`: one of its
 * Build reports, or the Build the Preview runs when the page reads it. A failed
 * Build leaves it as it was, as the Preview does.
 */
export function latestGoodHash(previous: string | null, build: Pick<BuildReport, "hash" | "ok"> | null): string | null {
  return build?.ok ? build.hash : previous;
}

/** What the page has seen of the Builds, and from it the latest successful Build's hash. */
export interface BuildsSeen {
  /** The latest Build report. */
  report: Pick<BuildReport, "hash" | "ok"> | null;
  /** The latest read of the Preview: each read is a new object, so a read that repeats an earlier hash still counts. */
  preview: { hash: string | null } | null;
  goodHash: string | null;
}

export const noBuildsSeen: BuildsSeen = { report: null, preview: null, goodHash: null };

/**
 * What the page has seen once it has `report` and `preview`. Whichever is new
 * moves the latest successful Build on, the read of the Preview last, as it's
 * what the platform runs now. Returns `seen` itself when neither is new.
 */
export function seeBuilds(seen: BuildsSeen, report: BuildsSeen["report"], preview: BuildsSeen["preview"]): BuildsSeen {
  if (report === seen.report && preview === seen.preview) return seen;
  let goodHash = seen.goodHash;
  if (report !== seen.report) goodHash = latestGoodHash(goodHash, report);
  if (preview !== seen.preview && preview?.hash) goodHash = preview.hash;
  return { report, preview, goodHash };
}
