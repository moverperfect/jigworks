import { afterEach, describe, expect, it, vi } from "vitest";
import { askClaude } from "../addons/ai/src/server/ai";
import { sendEmail } from "../addons/email/src/server/email";
import { appAreaNotes, appAreaState, problemsNote, type AppAreaState } from "../client/src/appArea";
import type { PublishState } from "../client/src/publish";
import type { AppLogEntry } from "../src/shared/app-logs";
import type { LastTurn } from "../src/shared/conversation";
import { fakeResend, resendAccountAddress, resendKey } from "./fixtures/fake-resend";

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

describe("the note about the app's problems (#104)", () => {
  const line = (message: string, fields: Partial<AppLogEntry> = {}): AppLogEntry => ({
    at: "2026-11-09T10:00:00.000Z",
    slot: "preview",
    source: "server",
    level: "error",
    message,
    ...fields,
  });
  // The add-ons' own words for each refusal, as they log them (addons/email, addons/ai).
  const badResendKey = line("Resend refused the email: API key is invalid");
  const badAnthropicKey = line("Claude wasn't asked: Anthropic answered 401 (authentication_error): invalid x-api-key");
  const read = (...problems: AppLogEntry[]) => ({ hash: "build-2", problems });
  const lines = (problems: AppLogEntry[], hidden: string | null = null) =>
    problemsNote(read(...problems), "ready", "build-2", hidden)?.lines ?? null;

  it("says what the add-ons' other failures mean", () => {
    expect(lines([line("The email wasn't sent: Resend answered 500 Internal Server Error")])).toEqual(["Your app couldn't send an email."]);
    expect(lines([line("Claude's reply was cut off at 1024 tokens: ask for a shorter answer, or raise maxTokens.")])).toEqual(["Your app couldn't get an answer from Claude."]);
  });

  it("finds the refusal in a line the app logged with words of its own", () => {
    expect(lines([line("Couldn't email the owner: Resend refused the email: API key is invalid")])).toEqual(["Your app couldn't send an email: Resend refused the key."]);
  });

  it("says the app ran into a problem for any other server error", () => {
    expect(lines([line("Error: The list is missing", { level: "exception" })])).toEqual(["Your app ran into a problem."]);
  });

  it("says each once, newest last, at most three", () => {
    const other = line("TypeError: x is undefined", { level: "exception" });
    const noKey = line("Claude wasn't asked: the Secret ANTHROPIC_API_KEY hasn't been set yet.");
    const noCredit = line("Claude wasn't asked: Anthropic answered 400 (invalid_request_error): Your credit balance is too low");
    expect(lines([badResendKey, badAnthropicKey, badResendKey])).toEqual([
      "Your app couldn't ask Claude: Anthropic refused the key.",
      "Your app couldn't send an email: Resend refused the key.",
    ]);
    expect(lines([other, noKey, noCredit, badResendKey])).toEqual([
      "Your app couldn't ask Claude: it doesn't have the key yet.",
      "Your app couldn't ask Claude: the Anthropic account needs credit.",
      "Your app couldn't send an email: Resend refused the key.",
    ]);
  });

  it("leaves out warnings and front-end errors", () => {
    expect(lines([line("careful", { level: "warn" }), line("the page broke", { source: "browser" })])).toBeNull();
    expect(lines([])).toBeNull();
  });

  it("shows only beside a ready or live app, not while a Turn runs or after one failed", () => {
    for (const state of ["ready", "live"] as const) expect(problemsNote(read(badResendKey), state, "build-2", null)).not.toBeNull();
    for (const state of ["empty", "first-build", "updating", "failed"] as const) expect(problemsNote(read(badResendKey), state, "build-2", null)).toBeNull();
  });

  it("is cleared by a new Build, so an older Build's problems aren't shown beside it", () => {
    expect(problemsNote(read(badResendKey), "ready", "build-3", null)).toBeNull();
    expect(problemsNote({ hash: null, problems: [] }, "ready", "build-3", null)).toBeNull();
    expect(problemsNote(null, "ready", "build-2", null)).toBeNull();
  });

  it("stays hidden once the Developer hides it, until a newer error comes", () => {
    const at = (time: string) => `2026-11-09T10:00:${time}.000Z`;
    const first = line(badResendKey.message, { at: at("01") });
    const note = problemsNote(read(first), "ready", "build-2", null)!;
    expect(note.newest).toBe(at("01"));
    expect(lines([first], note.newest)).toBeNull();
    // Only what came after.
    expect(lines([first, line(badAnthropicKey.message, { at: at("02") })], note.newest)).toEqual(["Your app couldn't ask Claude: Anthropic refused the key."]);
    // Even once the hidden line has gone from the kept logs, or a Build that came back, or a new Secret, starts the list afresh.
    expect(lines([line(badResendKey.message, { at: at("03") })], note.newest)).toEqual(["Your app couldn't send an email: Resend refused the key."]);
  });
});

describe("the note's words, from what the add-ons log (#104)", () => {
  const said = (message: string) =>
    problemsNote(
      { hash: "build-2", problems: [{ at: "2026-11-09T10:00:00.000Z", slot: "preview", source: "server", level: "error", message }] },
      "ready",
      "build-2",
      null,
    )!.lines;
  const answering = (response: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const email = { to: resendAccountAddress, subject: "Hi", text: "Hi" };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says what the email add-on's refusals mean", async () => {
    const unset = await sendEmail({}, email);
    expect(!unset.ok && said(unset.error)).toEqual(["Your app couldn't send an email: it doesn't have the key yet."]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => (await fakeResend(new Request(input, init)))!);
    const refused = await sendEmail({ RESEND_API_KEY: "re_made_up" }, email);
    expect(!refused.ok && said(refused.error)).toEqual(["Your app couldn't send an email: Resend refused the key."]);
    const elsewhere = await sendEmail({ RESEND_API_KEY: resendKey }, { ...email, to: "ada@example.com" });
    expect(!elsewhere.ok && said(elsewhere.error)).toEqual([
      "Your app couldn't send an email: until you set up your own domain with Resend, it can only email the address you signed up with.",
    ]);
  });

  it("says what the AI add-on's refusals mean", async () => {
    const question = { prompt: "Sort this" };
    const unset = await askClaude({}, question);
    expect(!unset.ok && said(unset.error)).toEqual(["Your app couldn't ask Claude: it doesn't have the key yet."]);
    // As Anthropic answers a key it doesn't know, and a request without credit.
    answering(Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
    const refused = await askClaude({ ANTHROPIC_API_KEY: "made up" }, question);
    expect(!refused.ok && said(refused.error)).toEqual(["Your app couldn't ask Claude: Anthropic refused the key."]);
    answering(
      Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
        { status: 400 },
      ),
    );
    const broke = await askClaude({ ANTHROPIC_API_KEY: "a key" }, question);
    expect(!broke.ok && said(broke.error)).toEqual(["Your app couldn't ask Claude: the Anthropic account needs credit."]);
  });
});
