import { describe, expect, it } from "vitest";
import { describeLastTurn } from "../client/src/lastTurn";
import { restartedDuringTurn, type LastTurn } from "../src/shared/conversation";

// The Conversation's status line after a Turn, in plain words.

const turn = (fields: Partial<LastTurn>): LastTurn => ({
  endedAt: "2026-11-07T10:00:00.000Z",
  status: "completed",
  error: null,
  checkErrors: 0,
  buildErrors: 0,
  testFailures: 0,
  retries: 0,
  outOfSteps: false,
  ...fields,
});

const notStarted = { noApp: true, checkErrors: null, buildErrors: null, testFailures: null };
const restarted = { status: "aborted", error: restartedDuringTurn, checkErrors: null, buildErrors: null } as const;

describe("the last Turn's outcome", () => {
  it("says nothing after a Turn that went well", () => {
    expect(describeLastTurn(turn({ startedApp: true, noApp: false }))).toBeNull();
  });

  it("says the app wasn't started, and to try again, after a Turn that didn't start it", () => {
    expect(describeLastTurn(turn(notStarted))).toBe("The Agent didn't get your app started. Try again: say what you'd like to make.");
  });

  it("says nothing after a first Turn that only asked a question, which starts the app once it's answered", () => {
    expect(describeLastTurn(turn({ ...notStarted, asked: "question" }))).toBeNull();
  });

  it("says why a Turn that stopped early stopped, from the reason the platform stored", () => {
    expect(describeLastTurn(turn(restarted))).toBe(
      "The Agent stopped before it finished, because Jigworks restarted while it was working. Send a message to carry on.",
    );
    expect(describeLastTurn(turn({ status: "error", error: "Overloaded." }))).toBe(
      "The Agent stopped before it finished, because something went wrong: Overloaded. Send a message to carry on.",
    );
    expect(describeLastTurn(turn({ status: "error" }))).toBe(
      "The Agent stopped before it finished, because something went wrong. Send a message to carry on.",
    );
    expect(describeLastTurn(turn({ status: "aborted" }))).toBe(
      "The Agent stopped before it finished, because it was interrupted. Send a message to carry on.",
    );
  });

  it("says when the Agent reached its limit for one message, which it may have reached as it finished", () => {
    expect(describeLastTurn(turn({ outOfSteps: true }))).toBe(
      "The Agent reached its limit for one message, so it may not have finished. Send a message to carry on.",
    );
    expect(describeLastTurn(turn({ outOfSteps: true, checkErrors: 1 }))).toBe(
      "The Agent reached its limit for one message before it got the change working. Send a message to carry on.",
    );
  });

  it("says why a Turn that stopped before starting the app stopped, and that the app wasn't started", () => {
    expect(describeLastTurn(turn({ ...notStarted, status: "error", error: "Overloaded." }))).toBe(
      "The Agent stopped before it finished, because something went wrong: Overloaded, so your app wasn't started. Try again: say what you'd like to make.",
    );
    expect(describeLastTurn(turn({ ...notStarted, ...restarted }))).toBe(
      "The Agent stopped before it finished, because Jigworks restarted while it was working, so your app wasn't started. Try again: say what you'd like to make.",
    );
  });

  it("says the change didn't work after the Agent's tries", () => {
    expect(describeLastTurn(turn({ checkErrors: 2, retries: 3 }))).toBe("The Agent couldn't get the change working after 4 tries.");
    expect(describeLastTurn(turn({ buildErrors: 1, retries: 3 }))).toBe("The Agent couldn't get the change working after 4 tries.");
  });

  it("says the app hasn't changed after a Turn that was undone, and to try a different way", () => {
    const undone = { checkErrors: 1, retries: 3, restored: true };
    expect(describeLastTurn(turn(undone))).toBe("That didn't work. Your app hasn't changed. Try asking for it in a different way.");
    expect(describeLastTurn(turn({ ...undone, noApp: true }))).toBe(
      "That didn't work. Nothing's been made yet. Try asking for it in a different way.",
    );
    // The Developer answers the question rather than trying another way.
    expect(describeLastTurn(turn({ ...undone, retries: 0, asked: "question" }))).toBe(
      "That didn't work. Your app hasn't changed. Answer the Agent's question to carry on.",
    );
    expect(describeLastTurn(turn({ ...undone, retries: 0, asked: "secret" }))).toBe(
      "That didn't work. Your app hasn't changed. Add the secret the Agent asked for to carry on.",
    );
    expect(describeLastTurn(turn({ ...undone, outOfSteps: true }))).toBe(
      "The Agent reached its limit for one message before it got the change working. Your app hasn't changed. Try asking for a smaller change.",
    );
    expect(describeLastTurn(turn({ ...undone, ...restarted, checkErrors: 1 }))).toBe(
      "The Agent stopped before it finished, because Jigworks restarted while it was working, and its changes didn't work. Your app hasn't changed. Send a message to try again.",
    );
    expect(describeLastTurn(turn({ ...undone, ...restarted, checkErrors: 1, noApp: true }))).toBe(
      "The Agent stopped before it finished, because Jigworks restarted while it was working, and its changes didn't work. Nothing's been made yet. Send a message to try again.",
    );
  });

  it("says when the change is in but the app's tests fail", () => {
    expect(describeLastTurn(turn({ testFailures: 1 }))).toBe("The change is in, but 1 of your app's tests fails.");
    expect(describeLastTurn(turn({ testFailures: 2 }))).toBe("The change is in, but 2 of your app's tests fail.");
  });
});
