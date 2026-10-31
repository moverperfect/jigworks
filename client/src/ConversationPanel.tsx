import { getToolName, isTextUIPart, isToolUIPart, type DynamicToolUIPart, type ToolUIPart } from "ai";
import {
  createElement,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { isSummary, maxRetries, type LastTurn } from "../../src/shared/conversation.ts";
import { startFresh, startTurn, toApiError, type ApiError } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorMessage } from "./ErrorMessage";
import { renderMarkdown, type MarkdownNode } from "./markdown";
import type { Conversation, ConversationMessage } from "./useConversation";

type ToolPart = ToolUIPart | DynamicToolUIPart;

/** How each tool reads: after "Couldn't", while it runs, and once it's done. */
const toolVerbs: Record<string, [failed: string, running: string, done: string]> = {
  read: ["read", "Reading", "Read"],
  write: ["write", "Writing", "Wrote"],
  edit: ["edit", "Editing", "Edited"],
  list: ["list", "Listing", "Listed"],
  find: ["find files matching", "Finding files matching", "Found files matching"],
  grep: ["search for", "Searching for", "Searched for"],
  delete: ["delete", "Deleting", "Deleted"],
  bash: ["run", "Running", "Ran"],
  check: ["check", "Checking", "Checked"],
  build: ["build", "Building", "Built"],
  add_package: ["add", "Adding", "Added"],
};

/** The Conversation: its messages, what the Agent is doing, and the composer. Turns start over HTTP. */
export function ConversationPanel({
  id,
  conversation,
  unsavedChanges,
}: {
  id: string;
  conversation: Conversation;
  /** Whether the open file has unsaved changes, which the Agent might overwrite. */
  unsavedChanges: boolean;
}) {
  const headingId = useId();
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  // Follow new messages unless the Developer has scrolled up to read.
  const following = useRef(true);
  const { messages, state, connected } = conversation;

  const idle = connected && state !== null && state.turn === null && !state.startingFresh && !posting;
  const canSend = idle && !unsavedChanges;
  const turnRunning = state?.turn != null;

  useLayoutEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  /** Starts a Turn or Start fresh, showing any error beside the composer. */
  async function post(action: () => Promise<void>) {
    setPosting(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setPosting(false);
    }
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    following.current = true;
    void post(() => startTurn(id, text).then(() => setText("")));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends and Shift+Enter starts a new line. Enter that picks an IME suggestion does neither.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  return (
    <section className="workspace-conversation" aria-labelledby={`${headingId}-heading`}>
      <div className="conversation-header">
        <h2 id={`${headingId}-heading`} className="pane-heading conversation-heading">
          Conversation
        </h2>
        <button
          type="button"
          className="button button-small"
          onClick={() => setConfirming(true)}
          disabled={!idle || messages.length === 0}
        >
          Start fresh
        </button>
      </div>

      <ol
        ref={list}
        className="conversation-messages"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {connected && messages.length === 0 && !turnRunning && (
          <li className="conversation-empty">Tell the Agent what to build or change.</li>
        )}
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} turnRunning={turnRunning} />
        ))}
      </ol>

      <ConversationStatus conversation={conversation} />

      <form className="composer" onSubmit={send}>
        <label htmlFor={`${headingId}-message`} className="visually-hidden">
          Message to the Agent
        </label>
        <textarea
          id={`${headingId}-message`}
          className="composer-input"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={unsavedChanges ? `${headingId}-unsaved` : undefined}
        />
        {error && <ErrorMessage error={error} />}
        <div className="composer-actions">
          <p id={`${headingId}-unsaved`} className="hint">
            {unsavedChanges ? "Save your changes before you send a message" : "Shift+Enter starts a new line"}
          </p>
          <button type="submit" className="button button-primary button-small" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>

      {confirming && (
        <ConfirmDialog
          title="Start fresh?"
          confirm="Start fresh"
          onClose={() => setConfirming(false)}
          onConfirm={() => void post(() => startFresh(id))}
        >
          The Agent summarises everything after your first message, then carries on from the summary. The messages it
          summarises won't be shown any more.
        </ConfirmDialog>
      )}
    </section>
  );
}

function MessageItem({ message, turnRunning }: { message: ConversationMessage; turnRunning: boolean }) {
  const texts = message.parts.filter(isTextUIPart);
  const { metadata } = message;

  if (message.role === "user" && metadata?.from === "check") {
    return (
      <li className="conversation-notice">
        <p>
          {describeFound(metadata.errors, metadata.buildErrors ?? 0)}, so the Agent is trying again (retry {metadata.retry}{" "}
          of {maxRetries})
        </p>
        <details>
          <summary>What the Agent was told</summary>
          <pre className="conversation-pre">{texts.map((part) => part.text).join("\n\n")}</pre>
        </details>
      </li>
    );
  }

  if (message.role === "user") {
    // Any second text part is the platform's note to the Agent, so say it from `changedFiles` instead.
    const changedFiles = metadata?.from === "developer" ? metadata.changedFiles : [];
    return (
      <li className="conversation-item from-developer">
        <p className="conversation-text">
          <span className="visually-hidden">You: </span>
          {texts[0]?.text}
        </p>
        {changedFiles.length > 0 && <p className="conversation-note">Told the Agent you changed {changedFiles.join(", ")}</p>}
      </li>
    );
  }

  // Start fresh's summary stands in for every message after the first.
  if (isSummary(message)) {
    return (
      <li className="conversation-item conversation-summary">
        <p className="conversation-summary-heading">Summary of the Conversation so far</p>
        <Markdown text={texts.map((part) => part.text).join("\n\n")} />
      </li>
    );
  }

  const parts = message.parts.map((part, index): ReactNode => {
    if (isTextUIPart(part)) {
      return part.text ? <Markdown key={index} text={part.text} streaming={part.state === "streaming"} /> : null;
    }
    if (isToolUIPart(part)) return <ToolLine key={index} part={part} turnRunning={turnRunning} />;
    if (part.type === "reasoning" && part.state === "streaming") {
      return (
        <p key={index} className="conversation-thinking">
          Thinking…
        </p>
      );
    }
    return null;
  });
  if (parts.every((part) => part === null)) return null;
  return (
    <li className="conversation-item from-agent">
      <span className="visually-hidden">The Agent: </span>
      {parts}
    </li>
  );
}

/** The Agent's Markdown. Memoised, so only the reply that's streaming renders again as it grows. */
const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return createElement("div", { className: "markdown" }, ...renderMarkdown(text, streaming).map(toReact));
});

/** Children passed one by one to createElement, unlike a JSX array, need no keys. */
function toReact(node: MarkdownNode): ReactNode {
  return typeof node === "string" ? node : createElement(node.tag, node.attributes, ...node.children.map(toReact));
}

/** One line for a tool the Agent used, with its output behind a disclosure. */
function ToolLine({ part, turnRunning }: { part: ToolPart; turnRunning: boolean }) {
  const name = getToolName(part);
  const [failedVerb, runningVerb, doneVerb] = toolVerbs[name] ?? [`use ${name}`, `Using ${name}`, `Used ${name}`];
  const subject = toolSubject(name, part.input);
  const done = part.state === "output-available";
  // A tool still waiting when no Turn is running was cut short.
  const failed = part.state === "output-error" || part.state === "output-denied" || (!done && !turnRunning);
  const running = !done && !failed;

  const verb = failed ? `Couldn't ${failedVerb}` : running ? runningVerb : doneVerb;
  const label = (
    <>
      {verb}
      {subject && (
        <>
          {" "}
          <code>{subject}</code>
        </>
      )}
      {running && "…"}
    </>
  );
  const className = `tool-line tool-${failed ? "failed" : running ? "running" : "done"}`;

  let output: string | null = null;
  if (part.state === "output-error") output = part.errorText;
  else if (part.state === "output-available") output = describeOutput(part.output);
  if (output === null) return <p className={className}>{label}</p>;
  return (
    <details className={className}>
      <summary>{label}</summary>
      <pre className="conversation-pre">{output}</pre>
    </details>
  );
}

/** What a tool worked on, from its input, which is partial while the model writes it. */
function toolSubject(name: string, input: unknown): string {
  const field = (key: string) => {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value : "";
  };
  switch (name) {
    case "check":
    case "build":
      return "";
    case "find":
      return field("pattern");
    case "grep":
      return field("query");
    case "add_package":
      return field("name");
    case "bash": {
      const script = field("script").trim();
      const firstLine = script.split("\n", 1)[0] ?? "";
      return firstLine.length > 60 || firstLine !== script ? `${firstLine.slice(0, 60)}…` : firstLine;
    }
    default:
      return field("path");
  }
}

function describeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2) ?? "";
}

/** Whether the socket is connected, and what the Agent is doing or last did. */
function ConversationStatus({ conversation }: { conversation: Conversation }) {
  const { state, connected, failed } = conversation;
  const startedAt = connected ? state?.turn?.startedAt : undefined;
  const now = useNow(startedAt !== undefined);

  let status: ReactNode = null;
  let warning = false;
  if (failed) status = "Couldn't connect to the Conversation. Reload the page to try again.";
  else if (!connected) status = state ? "Disconnected. Reconnecting…" : "Connecting…";
  else if (state?.startingFresh) status = "Starting fresh…";
  else if (startedAt !== undefined) status = "The Agent is working…";
  else if (state?.lastTurn) {
    status = describeLastTurn(state.lastTurn);
    warning = status !== null;
  }

  return (
    <div className={`conversation-status${warning ? " conversation-status-warning" : ""}`}>
      <p role="status">{status}</p>
      {/* Outside the live region, so it isn't read out every second. */}
      {startedAt !== undefined && <span>{formatElapsed(now - Date.parse(startedAt))}</span>}
    </div>
  );
}

/** The last Turn's outcome, if it's worth saying. */
function describeLastTurn(lastTurn: LastTurn): string | null {
  if (lastTurn.status === "error") return lastTurn.error ? `The Turn failed: ${lastTurn.error}` : "The Turn failed";
  if (lastTurn.status === "aborted") return "The Turn stopped before it finished";
  const said: string[] = [];
  if (lastTurn.outOfSteps) said.push("The Agent used all the Turn's steps");
  const left = [
    lastTurn.checkErrors ? plural(lastTurn.checkErrors, "error") : null,
    lastTurn.buildErrors ? "a failed Build" : null,
    lastTurn.testFailures ? plural(lastTurn.testFailures, "test failure") : null,
  ].filter((part) => part !== null);
  if (left.length > 0) {
    const retries = lastTurn.retries > 0 ? ` after ${plural(lastTurn.retries, "retry", "retries")}` : "";
    const listed = left.length > 1 ? `${left.slice(0, -1).join(", ")} and ${left.at(-1)}` : left[0];
    said.push(`${said.length > 0 ? "the" : "The"} Turn ended with ${listed}${retries}`);
  }
  return said.length > 0 ? said.join(", and ") : null;
}

/** What a Turn's Check and Build found, for the platform's message asking the Agent to fix it. */
function describeFound(checkErrors: number, buildErrors: number): string {
  if (buildErrors === 0) return `The Check found ${plural(checkErrors, "error")}`;
  if (checkErrors === 0) return "The Build failed";
  return `The Check found ${plural(checkErrors, "error")} and the Build failed`;
}

/** The time now, updated every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function formatElapsed(ms: number): string {
  // The platform's clock and this one can disagree a little.
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function plural(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
