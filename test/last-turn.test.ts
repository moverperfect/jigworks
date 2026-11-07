import { describe, expect, it } from "vitest";
import { describeLastTurn } from "../client/src/lastTurn";
import type { LastTurn } from "../src/shared/conversation";

// The Conversation's status line after a Turn.

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

describe("the last Turn's outcome", () => {
  it("says nothing after a Turn that went well", () => {
    expect(describeLastTurn(turn({ startedApp: true, noApp: false }))).toBeNull();
  });

  it("says the app wasn't started, and to try again, after a Turn that didn't start it", () => {
    expect(describeLastTurn(turn(notStarted))).toBe("The Agent didn't get your app started. Try again: say what you'd like to make.");
  });

  it("says why a Turn that failed or stopped before starting the app ended, and that the app wasn't started", () => {
    expect(describeLastTurn(turn({ ...notStarted, status: "error", error: "Overloaded." }))).toBe(
      "The Turn failed: Overloaded, so your app wasn't started. Try again: say what you'd like to make.",
    );
    expect(describeLastTurn(turn({ ...notStarted, status: "aborted" }))).toBe(
      "The Turn stopped before it finished, so your app wasn't started. Try again: say what you'd like to make.",
    );
  });

  it("says what a Turn left broken, as before", () => {
    expect(describeLastTurn(turn({ checkErrors: 2, retries: 3 }))).toBe("The Turn ended with 2 errors after 3 retries");
  });
});
