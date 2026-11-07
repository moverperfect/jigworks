import { getToolName, isTextUIPart, isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { maxRetries, type ConversationState } from "../../src/shared/conversation.ts";
import { plural } from "./lastTurn";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** One of the Agent's steps, in plain words, from its `steps` tool or described from its tool calls. */
export interface Step {
  label: string;
  done: boolean;
}

/**
 * What an Agent message shows, in order: its text, and one list of steps
 * where its first tool call was, with the tool calls behind them folded
 * under "Technical details".
 */
type MessageBlock =
  | { kind: "text"; text: string; streaming: boolean }
  /** `fromAgent` when the steps are the Agent's own list, rather than its tool calls described. */
  | { kind: "steps"; steps: Step[]; tools: ToolPart[]; fromAgent: boolean }
  | { kind: "thinking" };

/** How each tool reads in plain words, when the Agent hasn't said its steps itself. */
const plainTools: Record<string, string> = {
  start_app: "Starting your app",
  read: "Looking at your app",
  list: "Looking at your app",
  find: "Looking at your app",
  grep: "Looking at your app",
  write: "Changing your app",
  edit: "Changing your app",
  delete: "Changing your app",
  bash: "Changing your app",
  add_package: "Adding a ready-made part",
  check: "Checking for mistakes",
  build: "Building your app",
  test: "Testing your app",
  request_preview: "Trying your app",
  preview_logs: "Seeing how your app ran",
  list_secrets: "Looking at your app's Secrets",
};

/** A tool call in plain words, for example `build` as "Building your app". */
export function describeTool(name: string): string {
  return plainTools[name] ?? "Working on your app";
}

/** The blocks an Agent message shows, from its parts. */
export function agentMessageBlocks(parts: UIMessage["parts"]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const tools = parts.filter(isToolUIPart);
  let stepsShown = false;
  for (const part of parts) {
    if (isTextUIPart(part)) {
      if (part.text) blocks.push({ kind: "text", text: part.text, streaming: part.state === "streaming" });
    } else if (isToolUIPart(part)) {
      if (stepsShown) continue;
      stepsShown = true;
      const others = tools.filter((tool) => getToolName(tool) !== "steps");
      const own = latestSteps(tools);
      const steps = own ?? describeTools(others);
      if (steps.length > 0 || others.length > 0) blocks.push({ kind: "steps", steps, tools: others, fromAgent: own !== null });
    } else if (part.type === "reasoning" && part.state === "streaming") {
      blocks.push({ kind: "thinking" });
    }
  }
  return blocks;
}

/** The latest list the Agent gave with `steps`, once the model has finished writing it and the platform took it. */
function latestSteps(tools: ToolPart[]): Step[] | null {
  for (const tool of tools.toReversed()) {
    if (getToolName(tool) !== "steps" || !tookSteps.has(tool.state)) continue;
    const steps = (tool.input as { steps?: unknown } | undefined)?.steps;
    if (!Array.isArray(steps)) continue;
    const valid = steps.filter(
      (step): step is Step => typeof step?.label === "string" && step.label.trim() !== "" && typeof step.done === "boolean",
    );
    if (valid.length > 0) return valid;
  }
  return null;
}

const tookSteps = new Set<ToolPart["state"]>(["input-available", "output-available"]);

/** Tool calls in plain words, with calls in a row that read the same as one step. A call that failed still finished. */
function describeTools(tools: ToolPart[]): Step[] {
  const steps: Step[] = [];
  for (const tool of tools) {
    const label = describeTool(getToolName(tool));
    const done = tool.state === "output-available" || tool.state === "output-error" || tool.state === "output-denied";
    const last = steps.at(-1);
    if (last?.label === label) last.done &&= done;
    else steps.push({ label, done });
  }
  return steps;
}

/** How many of the steps are done, for example "1 of 2 steps done". */
export function stepsDone(steps: Step[]): string {
  return `${steps.filter((step) => step.done).length} of ${plural(steps.length, "step")} done`;
}

/** The platform's message asking the Agent to fix what a Turn's Check and Build found, as normal work. */
export function describeRetry(retry: number): string {
  return `Found a problem, fixing it (try ${retry} of ${maxRetries})`;
}

/** How far the running Turn has got, for the app area. */
export interface TurnProgress {
  /** What's happening now, in plain words. */
  current: string;
  /** The steps of the Agent's latest list, if it has one. */
  steps: Step[];
}

/**
 * The running Turn's progress: what's happening now, from the Agent's latest
 * list since the Developer's message that started the Turn (or its tool calls
 * described, when it gave none), and the platform's own work: fixing a
 * problem after a retry, until the Agent gives a new list, and making sure it
 * works. The Turn starts a moment before its message arrives.
 */
export function turnProgress(
  messages: UIMessage<{ from?: string; turnStartedAt?: string }>[],
  turn: NonNullable<ConversationState["turn"]>,
): TurnProgress {
  const since = messages.findLastIndex((message) => message.metadata?.turnStartedAt === turn.startedAt);
  let own: Step[] | null = null;
  let described: Step[] = [];
  let fixing = false;
  for (const message of since === -1 ? [] : messages.slice(since + 1)) {
    if (message.role === "user" && message.metadata?.from === "check") fixing = true;
    if (message.role !== "assistant") continue;
    const block = agentMessageBlocks(message.parts).find((found) => found.kind === "steps");
    if (!block || block.steps.length === 0) continue;
    if (!block.fromAgent) described = block.steps;
    else {
      own = block.steps;
      fixing = false;
    }
  }
  const steps = own ?? described;
  if (turn.stage === "checking") return { current: "Making sure it works", steps };
  if (fixing) return { current: "Fixing a problem", steps };
  const current = steps.length === 0 ? "Getting ready" : (steps.find((step) => !step.done)?.label ?? "Finishing off");
  return { current, steps };
}
