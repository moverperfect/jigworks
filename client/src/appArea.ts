import { isWarning, type PreviewProblems } from "../../src/shared/app-logs.ts";
import type { ConversationState } from "../../src/shared/conversation.ts";
import type { TurnProgress } from "./agentMessage";
import { liveNote, type PublishState } from "./publish";

/**
 * What the app area shows in place of the app, or around it:
 * - `empty`: no Build has succeeded and no Turn is running;
 * - `first-build`: a Turn is running before any Build has succeeded;
 * - `updating`: a Turn is running over a working app;
 * - `ready`: a working app, and no Turn running;
 * - `failed`: the last Turn left the app broken, and so was undone;
 * - `live`: a ready app whose Deployment runs its latest Build, so the jig lets it go.
 */
export type AppAreaState = "empty" | "first-build" | "updating" | "ready" | "failed" | "live";

/**
 * The app area's state, from the Conversation's state (null until the socket
 * sends it), whether a Build has succeeded, so the Preview has one to run,
 * the publish state (null until the page knows it), and whether the
 * Developer left a failed change for now, which takes the failure away.
 * A Turn leaves the app broken when its last Check had errors or its last
 * Build failed, and is then undone (ADR 0018). One that wasn't undone, such
 * as one that was running when undoing was deployed, isn't shown as failed,
 * since its app may have changed.
 */
export function appAreaState(
  conversation: Pick<ConversationState, "turn" | "lastTurn"> | null,
  built: boolean,
  publish: PublishState | null = null,
  failureLeft = false,
): AppAreaState {
  if (conversation?.turn) return built ? "updating" : "first-build";
  if (conversation?.lastTurn?.restored && !failureLeft) return "failed";
  if (!built) return "empty";
  return publish === "live" ? "live" : "ready";
}

/** What the app area says about its state, beside the app, or in its place before there's one to show. */
const notes: Record<AppAreaState, { beside: string; instead: string }> = {
  empty: { beside: "", instead: "Your app appears here once it's built." },
  // The Turn's progress shows in place of the app.
  "first-build": { beside: "Making your app…", instead: "" },
  updating: { beside: "", instead: "Building your app…" },
  // The Preview learns of its first Build a moment after the page does.
  ready: { beside: "", instead: "Loading your app…" },
  // The Turn was undone (ADR 0018), and there's nothing to show when it was the one that started the app.
  failed: { beside: "That didn't work. Your app hasn't changed.", instead: "That didn't work. Nothing's been made yet." },
  // Beside it, `liveNote` says who can use it.
  live: { beside: "", instead: "Loading your app…" },
};

/** What a ready app's label says about who sees it, while it isn't live. */
const held: Record<Exclude<PublishState, "live">, string> = {
  "not-published": "Only you can see this until you publish.",
  "live-with-changes": "Changes not yet published. People with the link have the earlier version.",
};

/**
 * What the app area says in its `state`: `beside` the app, as the jig's
 * label, and `instead` of it before there's one to show. While a Turn
 * updates the app, the label says what the Turn is doing (`progress`); once
 * the app is ready, who can see or use it.
 */
export function appAreaNotes(
  state: AppAreaState,
  publishing: PublishState | null,
  progress: TurnProgress | null,
  openToEveryone: boolean,
): { beside: string; instead: string } {
  const note = notes[state];
  if (state === "updating" && progress) return { ...note, beside: `Updating your app: ${progress.current}…` };
  if (state === "live") return { ...note, beside: liveNote(openToEveryone) };
  if (state === "ready" && publishing && publishing !== "live") return { ...note, beside: held[publishing] };
  return note;
}

/**
 * What a server error stopped the app doing, in the page's words, from the
 * add-ons' own words for it (addons/email, addons/ai), wherever they are in
 * the line. The first that matches says it.
 */
const sayings: [RegExp, string][] = [
  [/Resend refused the email: API key is invalid/, "Your app couldn't send an email: Resend refused the key."],
  [/Resend refused the email: You can only send testing emails/, "Your app couldn't send an email: until you set up your own domain with Resend, it can only email the address you signed up with."],
  [/The email wasn't sent: the Secret \w+ hasn't been set yet/, "Your app couldn't send an email: it doesn't have the key yet."],
  [/Resend refused the email|The email wasn't sent/, "Your app couldn't send an email."],
  [/Claude wasn't asked: Anthropic answered 40[13]/, "Your app couldn't ask Claude: Anthropic refused the key."],
  [/Claude wasn't asked: Anthropic answered 400 .*credit/, "Your app couldn't ask Claude: the Anthropic account needs credit."],
  [/Claude wasn't asked: the Secret \w+ hasn't been set yet/, "Your app couldn't ask Claude: it doesn't have the key yet."],
  [/Claude wasn't asked|Claude's reply|Claude declined/, "Your app couldn't get an answer from Claude."],
];
const mostLinesShown = 3;

/**
 * The note beside a ready or live app about the server errors its Preview
 * logged since its latest Build, or since its Secrets changed (#104), each
 * said once in the page's words, newest last, with the time of the newest,
 * which hiding the note records. Null when there's nothing to say: in any
 * other state, when `read` is of a Build other than `goodHash`, the one the
 * page shows, or when the Developer hid the note at `hiddenThrough` and no
 * error came after. A new Build clears it, as its problems start afresh.
 */
export function problemsNote(
  read: PreviewProblems | null,
  state: AppAreaState,
  goodHash: string | null,
  hiddenThrough: string | null,
): { lines: string[]; newest: string } | null {
  if ((state !== "ready" && state !== "live") || !read?.hash || read.hash !== goodHash) return null;
  // ISO 8601 times from the app host's clock, so they sort as strings.
  const errors = read.problems.filter((entry) => entry.source === "server" && !isWarning(entry) && !(hiddenThrough && entry.at <= hiddenThrough));
  if (errors.length === 0) return null;
  const said = errors.map(({ message }) => sayings.find(([pattern]) => pattern.test(message))?.[1] ?? "Your app ran into a problem.");
  // Each once, where it last came.
  const lines = said.filter((line, index) => said.lastIndexOf(line) === index).slice(-mostLinesShown);
  return { lines, newest: errors.at(-1)!.at };
}
