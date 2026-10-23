// The Conversation as the platform and its pages share it.

/** How many more tries the Agent gets when a Turn's Check has errors. */
export const maxRetries = 3;

/** The Workspace agent's state, which every Conversation socket is sent when it changes. */
export interface ConversationState {
  /** The running Turn. While there is one, the Developer's changes to files and Packages are refused. */
  turn: { startedAt: string } | null;
  /** Whether Start fresh is summarising the Conversation. */
  startingFresh: boolean;
  /** How the last Turn ended, or null before the first. */
  lastTurn: LastTurn | null;
}

export interface LastTurn {
  endedAt: string;
  /** "completed" unless the model call failed or was cut short. */
  status: "completed" | "error" | "aborted" | "skipped";
  error: string | null;
  /** How many errors the Turn's last Check found, or null if no Check ran. */
  checkErrors: number | null;
  /** How many errors the Turn's last Build had, or null if no Build ran. */
  buildErrors: number | null;
  /** How many of the retries the Turn used. */
  retries: number;
  /** Whether the Turn stopped because it used all its model steps. */
  outOfSteps: boolean;
}

/**
 * Who wrote a user message: the Developer, or the platform after a Turn's
 * Check or Build had errors. `errors` counts the Check's; `buildErrors`, the
 * Build's, which messages from before Builds don't have.
 */
export type MessageMetadata =
  | { from: "developer"; changedFiles: string[] }
  | { from: "check"; errors: number; buildErrors?: number; retry: number };

export const idleState: ConversationState = { turn: null, startingFresh: false, lastTurn: null };

/** Whether a message is Start fresh's summary, which Think shows in place of the messages it folded. */
export const isSummary = (message: { id: string }) => message.id.startsWith("compaction_");
