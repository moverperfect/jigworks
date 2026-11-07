import type { ConversationState } from "../../src/shared/conversation.ts";
import type { PublishState } from "./publish";

/**
 * What the app area shows in place of the app, or around it:
 * - `empty`: no Build has succeeded and no Turn is running;
 * - `first-build`: a Turn is running before any Build has succeeded;
 * - `updating`: a Turn is running over a working app;
 * - `ready`: a working app, and no Turn running;
 * - `failed`: the last Turn left the app broken;
 * - `live`: a ready app whose Deployment runs its latest Build, so the jig lets it go.
 */
export type AppAreaState = "empty" | "first-build" | "updating" | "ready" | "failed" | "live";

/**
 * The app area's state, from the Conversation's state (null until the socket
 * sends it), whether a Build has succeeded, so the Preview has one to run,
 * and the publish state (null until the page knows it).
 * A Turn leaves the app broken when its last Check had errors or its last
 * Build failed; failing tests don't count (ADR 0018).
 */
export function appAreaState(
  conversation: Pick<ConversationState, "turn" | "lastTurn"> | null,
  built: boolean,
  publish: PublishState | null = null,
): AppAreaState {
  if (conversation?.turn) return built ? "updating" : "first-build";
  const lastTurn = conversation?.lastTurn;
  if (lastTurn && ((lastTurn.checkErrors ?? 0) > 0 || (lastTurn.buildErrors ?? 0) > 0)) return "failed";
  if (!built) return "empty";
  return publish === "live" ? "live" : "ready";
}
