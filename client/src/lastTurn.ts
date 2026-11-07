import { restartedDuringTurn, type LastTurn } from "../../src/shared/conversation.ts";

const tryAgain = "Try again: say what you'd like to make.";
const carryOn = "Send a message to carry on.";

/** What to do about what the Agent asked for, after a Turn that was undone. */
const answerIt: Record<NonNullable<LastTurn["asked"]>, string> = {
  question: "Answer the Agent's question to carry on.",
  secret: "Add the secret the Agent asked for to carry on.",
};

/** The reasons the platform stores for a Turn it ended, in plain words. */
const plainReasons: Record<string, string> = {
  [restartedDuringTurn]: "Jigworks restarted while it was working",
};

/** The last Turn's outcome, in plain words, for the Conversation's status line, if it's worth saying. */
export function describeLastTurn(lastTurn: LastTurn): string | null {
  const why = whyItStopped(lastTurn);
  const stopped = why && `The Agent stopped before it finished, because ${why}`;
  const broken = Boolean(lastTurn.checkErrors || lastTurn.buildErrors);
  // A Turn that left the app broken was undone, so whatever happened, the app is as it was (ADR 0018).
  if (lastTurn.restored) {
    const unchanged = lastTurn.noApp ? "Nothing's been made yet." : "Your app hasn't changed.";
    if (stopped) return `${stopped}, and its changes didn't work. ${unchanged} Send a message to try again.`;
    // The Developer answers what the Agent asked for, rather than trying another way.
    if (lastTurn.asked) return `That didn't work. ${unchanged} ${answerIt[lastTurn.asked]}`;
    if (lastTurn.outOfSteps) return `The Agent reached its limit for one message before it got the change working. ${unchanged} Try asking for a smaller change.`;
    return `That didn't work. ${unchanged} Try asking for it in a different way.`;
  }
  // Before the app has started there's nothing to check, so say so instead (ADR 0018).
  if (lastTurn.noApp) {
    if (stopped) return `${stopped}, so your app wasn't started. ${tryAgain}`;
    // A first Turn may only ask a question, and start the app once it's answered.
    return lastTurn.asked ? null : `The Agent didn't get your app started. ${tryAgain}`;
  }
  if (stopped) return `${stopped}. ${carryOn}`;
  // The model may have used its last step to finish, so this doesn't say it stopped early.
  if (lastTurn.outOfSteps) {
    const reached = "The Agent reached its limit for one message";
    return `${broken ? `${reached} before it got the change working` : `${reached}, so it may not have finished`}. ${carryOn}`;
  }
  if (broken) {
    return `The Agent couldn't get the change working after ${plural(lastTurn.retries + 1, "try", "tries")}.`;
  }
  const failures = lastTurn.testFailures ?? 0;
  if (failures > 0) return `The change is in, but ${failures} of your app's tests ${failures === 1 ? "fails" : "fail"}.`;
  return null;
}

/** Why a Turn stopped before it finished, or null if it didn't. */
function whyItStopped({ status, error }: LastTurn): string | null {
  if (status !== "error" && status !== "aborted") return null;
  if (error && plainReasons[error]) return plainReasons[error];
  if (error) return `something went wrong: ${error.replace(/\.$/, "")}`;
  return status === "error" ? "something went wrong" : "it was interrupted";
}

export function plural(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
