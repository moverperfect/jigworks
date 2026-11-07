import type { LastTurn } from "../../src/shared/conversation.ts";

const tryAgain = "Try again: say what you'd like to make.";

/** The last Turn's outcome, for the Conversation's status line, if it's worth saying. */
export function describeLastTurn(lastTurn: LastTurn): string | null {
  let stopped: string | null = null;
  if (lastTurn.status === "error") stopped = lastTurn.error ? `The Turn failed: ${lastTurn.error.replace(/\.$/, "")}` : "The Turn failed";
  else if (lastTurn.status === "aborted") stopped = "The Turn stopped before it finished";
  // Before the app has started there's nothing to check, so say so instead (ADR 0018).
  if (lastTurn.noApp) return stopped ? `${stopped}, so your app wasn't started. ${tryAgain}` : `The Agent didn't get your app started. ${tryAgain}`;
  if (stopped) return stopped;
  const said: string[] = [];
  if (lastTurn.outOfSteps) said.push("The Agent used all the Turn's steps");
  const left = [
    lastTurn.checkErrors ? plural(lastTurn.checkErrors, "error") : null,
    lastTurn.buildErrors ? "an app that doesn't build" : null,
    lastTurn.testFailures ? plural(lastTurn.testFailures, "test failure") : null,
  ].filter((part) => part !== null);
  if (left.length > 0) {
    const retries = lastTurn.retries > 0 ? ` after ${plural(lastTurn.retries, "retry", "retries")}` : "";
    const listed = left.length > 1 ? `${left.slice(0, -1).join(", ")} and ${left.at(-1)}` : left[0];
    said.push(`${said.length > 0 ? "the" : "The"} Turn ended with ${listed}${retries}`);
  }
  return said.length > 0 ? said.join(", and ") : null;
}

export function plural(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
