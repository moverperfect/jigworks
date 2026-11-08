import { describe, expect, it } from "vitest";
import { appAreaNotes, appAreaState, type AppAreaState } from "../client/src/appArea";
import type { PublishState } from "../client/src/publish";
import type { LastTurn } from "../src/shared/conversation";

// What the app's page shows in place of the app: worked out from the
// Conversation's state, whether a Build has succeeded, so the Preview has
// something to run, and whether the app is live.

const running = { turn: { startedAt: "2026-11-06T10:00:00.000Z", stage: "working" as const }, lastTurn: null };
const idle = { turn: null, lastTurn: null };

const ended = (fields: Partial<LastTurn>): { turn: null; lastTurn: LastTurn } => ({
  turn: null,
  lastTurn: {
    endedAt: "2026-11-06T10:05:00.000Z",
    status: "completed",
    error: null,
    checkErrors: 0,
    buildErrors: 0,
    testFailures: 0,
    retries: 0,
    outOfSteps: false,
    ...fields,
  },
});

describe("the app area's state", () => {
  it("is empty with no Build and no Turn", () => {
    expect(appAreaState(idle, false)).toBe("empty");
    // Before the socket has sent the Conversation's state.
    expect(appAreaState(null, false)).toBe("empty");
  });

  it("is the first build while a Turn runs before any Build has succeeded", () => {
    expect(appAreaState(running, false)).toBe("first-build");
  });

  it("is updating while a Turn runs over a working app", () => {
    expect(appAreaState(running, true)).toBe("updating");
    // A running Turn comes first, even after a failed one.
    expect(appAreaState({ ...running, lastTurn: ended({ checkErrors: 2 }).lastTurn }, true)).toBe("updating");
  });

  it("is ready with a working app and no Turn running", () => {
    expect(appAreaState(idle, true)).toBe("ready");
    expect(appAreaState(null, true)).toBe("ready");
    expect(appAreaState(ended({}), true)).toBe("ready");
  });

  it("is failed when the last Turn left the app broken, and so was undone (ADR 0018)", () => {
    expect(appAreaState(ended({ checkErrors: 3, retries: 3, restored: true }), true)).toBe("failed");
    expect(appAreaState(ended({ buildErrors: 1, restored: true }), true)).toBe("failed");
    expect(appAreaState(ended({ status: "error", error: "Overloaded", checkErrors: 1, restored: true }), true)).toBe("failed");
    // With nothing ever built, too, as after undoing the Turn that started the app.
    expect(appAreaState(ended({ buildErrors: 2, restored: true, noApp: true }), false)).toBe("failed");
  });

  it("isn't failed once the Developer leaves it for now, so it shows the app as it was (#80)", () => {
    expect(appAreaState(ended({ checkErrors: 3, retries: 3, restored: true }), true, "not-published", true)).toBe("ready");
    expect(appAreaState(ended({ buildErrors: 1, restored: true }), true, "live", true)).toBe("live");
    expect(appAreaState(ended({ buildErrors: 2, restored: true, noApp: true }), false, null, true)).toBe("empty");
  });

  it("isn't failed for a broken Turn that wasn't undone, since \"Your app hasn't changed\" wouldn't be true", () => {
    // Such as a Turn that was running when undoing was deployed.
    expect(appAreaState(ended({ checkErrors: 3, retries: 3 }), true)).toBe("ready");
    expect(appAreaState(ended({ buildErrors: 2, restored: false }), false)).toBe("empty");
  });

  it("isn't failed for failing tests, or for a Turn that stopped without leaving errors (ADR 0018)", () => {
    expect(appAreaState(ended({ testFailures: 4 }), true)).toBe("ready");
    expect(appAreaState(ended({ status: "error", error: "Overloaded", checkErrors: null, buildErrors: null }), true)).toBe("ready");
    expect(appAreaState(ended({ status: "aborted", checkErrors: null, buildErrors: null }), false)).toBe("empty");
  });

  it("is live when a ready app's Deployment runs its latest Build", () => {
    expect(appAreaState(idle, true, "live")).toBe("live");
    expect(appAreaState(ended({}), true, "live")).toBe("live");
  });

  it("holds the app while it isn't live, has changes not yet published, or is busy or broken", () => {
    expect(appAreaState(idle, true, "not-published")).toBe("ready");
    expect(appAreaState(idle, true, "live-with-changes")).toBe("ready");
    expect(appAreaState(running, true, "live")).toBe("updating");
    expect(appAreaState(ended({ buildErrors: 1, restored: true }), true, "live")).toBe("failed");
  });
});

describe("what the app area says", () => {
  const progress = { current: "Adding a waiting list", steps: [] };
  const said = (state: AppAreaState, publishing: PublishState | null = null) =>
    appAreaNotes(state, publishing, state === "first-build" || state === "updating" ? progress : null, false);

  it("is that the app is being made during the first build, with the Turn's progress in its place", () => {
    expect(said("first-build")).toEqual({ beside: "Making your app…", instead: "" });
  });

  it("is what's being updated while a Turn changes a working app", () => {
    expect(said("updating").beside).toBe("Updating your app: Adding a waiting list…");
  });

  it("is who can see a ready app, and who can use a live one", () => {
    expect(said("ready", "not-published").beside).toBe("Only you can see this until you publish.");
    expect(said("ready", "live-with-changes").beside).toBe("Changes not yet published. People with the link have the earlier version.");
    expect(said("live", "live").beside).toBe("Live. Only people on this Jigworks's list can use it.");
  });

  it("is that the change didn't work after a Turn that was undone", () => {
    expect(said("failed")).toEqual({ beside: "That didn't work. Your app hasn't changed.", instead: "That didn't work. Nothing's been made yet." });
  });
});
