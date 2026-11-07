import { describe, expect, it } from "vitest";
import {
  firstPublishNote,
  latestGoodHash,
  liveNote,
  forgetBuilds,
  noBuildsSeen,
  publishState,
  seeBuilds,
} from "../client/src/publish";

// What the app's page says about publishing: worked out from the hash of the
// Build the Deployment runs and the hash of the latest successful Build.

const built = (hash: string, ok = true) => ({ hash, ok });

describe("the publish state", () => {
  it("is not published with no Deployment", () => {
    expect(publishState(null, null)).toBe("not-published");
    expect(publishState(null, "a")).toBe("not-published");
  });

  it("is live when the Deployment runs the latest successful Build", () => {
    expect(publishState("a", "a")).toBe("live");
  });

  it("is live with changes when the latest successful Build differs from the Deployment's", () => {
    expect(publishState("a", "b")).toBe("live-with-changes");
  });

  it("is unknown while the page knows of no successful Build, as one was published", () => {
    expect(publishState("a", null)).toBe(null);
  });

  it("doesn't count a failed latest Build as a change to publish", () => {
    expect(publishState("a", latestGoodHash("a", built("b", false)))).toBe("live");
    expect(publishState("a", latestGoodHash("a", built("b")))).toBe("live-with-changes");
  });
});

describe("the latest successful Build", () => {
  it("moves on with each successful Build, and stays put for a failed one or none", () => {
    expect(latestGoodHash(null, null)).toBe(null);
    expect(latestGoodHash(null, built("a"))).toBe("a");
    expect(latestGoodHash("a", built("b"))).toBe("b");
    expect(latestGoodHash("a", built("b", false))).toBe("a");
    expect(latestGoodHash("a", null)).toBe("a");
  });
});

describe("the Builds the page has seen", () => {
  const read = (hash: string | null) => ({ hash });

  it("takes whichever came last: a successful Build report or a read of the Preview", () => {
    let seen = seeBuilds(noBuildsSeen, null, read("a"));
    expect(seen.goodHash).toBe("a");
    seen = seeBuilds(seen, built("b"), seen.preview);
    expect(seen.goodHash).toBe("b");
    seen = seeBuilds(seen, built("c", false), seen.preview);
    expect(seen.goodHash).toBe("b");
    seen = seeBuilds(seen, seen.report, read("d"));
    expect(seen.goodHash).toBe("d");
  });

  it("takes a new read of the Preview even when it gives a hash the page has read before", () => {
    // Another tab went back to "a" and built it, after this page built "b".
    let seen = seeBuilds(noBuildsSeen, null, read("a"));
    seen = seeBuilds(seen, built("b"), seen.preview);
    seen = seeBuilds(seen, seen.report, read("a"));
    expect(publishState("b", seen.goodHash)).toBe("live-with-changes");
  });

  it("stays the same when nothing new was seen, and ignores a read with no Build", () => {
    const seen = seeBuilds(noBuildsSeen, built("a"), read("a"));
    expect(seeBuilds(seen, seen.report, seen.preview)).toBe(seen);
    expect(seeBuilds(seen, seen.report, read(null)).goodHash).toBe("a");
  });
});

describe("forgetting the Builds seen", () => {
  const read = (hash: string | null) => ({ hash });

  it("forgets the app that went, counting only Build reports and reads of the Preview newer than it", () => {
    // Undoing the Turn that started the app removed the app the page last saw.
    const report = built("a");
    const preview = read("a");
    let seen = forgetBuilds(report, preview);
    expect(seeBuilds(seen, report, preview).goodHash).toBe(null);
    seen = seeBuilds(seen, report, read(null));
    expect(seen.goodHash).toBe(null);
    expect(seeBuilds(seen, built("b"), seen.preview).goodHash).toBe("b");
  });
});

describe("who can use a live app", () => {
  it("is anyone with the link when the Installation's Deployments are open to everyone", () => {
    expect(firstPublishNote(true, "sunday-runs.example.app")).toBe(
      "Anyone with the link will be able to use it, at sunday-runs.example.app.",
    );
    expect(liveNote(true)).toBe("Live. Anyone with the link can use it.");
  });

  it("is only the people on this Jigworks's list when they aren't", () => {
    expect(firstPublishNote(false, "sunday-runs.example.app")).toBe(
      "Only people on this Jigworks's list will be able to use it, at sunday-runs.example.app, once they've signed in.",
    );
    expect(liveNote(false)).toBe("Live. Only people on this Jigworks's list can use it.");
  });
});
