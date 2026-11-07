import { getToolName, isTextUIPart } from "ai";
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
import { isSummary } from "../../src/shared/conversation.ts";
import {
  agentMessageBlocks,
  describeRetry,
  openQuestion,
  suggestionsToShow,
  type Question,
  type Step,
  type ToolPart,
} from "./agentMessage";
import { setSecret, startTurn, toApiError, type ApiError } from "./api";
import { sendsMessage } from "./composer";
import { ErrorMessage } from "./ErrorMessage";
import { describeLastTurn } from "./lastTurn";
import { renderMarkdown, type MarkdownNode } from "./markdown";
import type { Conversation, ConversationMessage } from "./useConversation";

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
  visible,
}: {
  id: string;
  conversation: Conversation;
  /** Whether the open file has unsaved changes, which the Agent might overwrite. */
  unsavedChanges: boolean;
  /** Whether the pane is on screen. A hidden one can't scroll, so it catches up when it's shown again. */
  visible: boolean;
}) {
  const headingId = useId();
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Follow new messages unless the Developer has scrolled up to read.
  const following = useRef(true);
  const { messages, state, connected } = conversation;

  const canSend = conversation.idle && !posting && !unsavedChanges;
  const turnRunning = state?.turn != null;
  const question = openQuestion(messages, conversation.idle);
  const suggestions = suggestionsToShow(messages, conversation.idle);

  useLayoutEffect(() => {
    const element = list.current;
    if (element && visible && following.current) element.scrollTop = element.scrollHeight;
  }, [messages, visible]);

  /** Starts a Turn with what the Developer typed, showing any error beside the composer. */
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (await sendMessage(text)) setText("");
  }

  /** Sends an answer or a suggestion as an ordinary message, leaving what the Developer typed, and keeps focus in the Conversation as the buttons go. */
  async function pick(message: string) {
    input.current?.focus();
    await sendMessage(message);
  }

  /** Saves the Secret the Agent asked for through the Secrets route, then starts the next Turn from it. Throws what went wrong, for the field to show. */
  async function addSecret(name: string, value: string) {
    following.current = true;
    setPosting(true);
    setError(null);
    try {
      await setSecret(id, name, value);
      await startTurn(id, { secret: name });
    } finally {
      setPosting(false);
    }
  }

  /** Starts a Turn with `message`, and says whether it started. */
  async function sendMessage(message: string): Promise<boolean> {
    if (!canSend) return false;
    following.current = true;
    setPosting(true);
    setError(null);
    try {
      await startTurn(id, message);
      return true;
    } catch (caught) {
      setError(toApiError(caught));
      return false;
    } finally {
      setPosting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!sendsMessage(event)) return;
    event.preventDefault();
    void send();
  }

  return (
    <section className="workspace-conversation" aria-labelledby={`${headingId}-heading`}>
      <h2 id={`${headingId}-heading`} className="visually-hidden">
        Conversation
      </h2>

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
        {messages.map((message, index) => (
          <MessageItem
            key={message.id}
            message={message}
            turnRunning={turnRunning}
            answers={
              question && index === messages.length - 1
                ? { question: question.id, disabled: !canSend, pick: (choice) => void pick(choice), addSecret }
                : null
            }
          />
        ))}
      </ol>

      <ConversationStatus conversation={conversation} />

      {suggestions.length > 0 && (
        <ul className="suggestions" aria-label="Ideas for what to change next">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button type="button" className="link-button suggestion" disabled={!canSend} onClick={() => void pick(suggestion)}>
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="composer" onSubmit={(event) => void send(event)}>
        <label htmlFor={`${headingId}-message`} className="visually-hidden">
          Message to the Agent
        </label>
        <textarea
          ref={input}
          id={`${headingId}-message`}
          className="composer-input"
          rows={3}
          // While a Secret is asked for, the placeholder doesn't invite its value, which would enter the Conversation.
          placeholder={
            turnRunning
              ? "The Agent is working…"
              : question?.asked === "secret"
                ? "Or ask for something else…"
                : question
                  ? "Or type an answer…"
                  : "Ask for a change…"
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={turnRunning || unsavedChanges ? `${headingId}-hint` : undefined}
        />
        {error && <ErrorMessage error={error} />}
        <div className="composer-actions">
          <p id={`${headingId}-hint`} className="hint">
            {turnRunning
              ? "The Agent is working. You can send a message when it's done."
              : unsavedChanges
                ? "Save your changes before you send a message"
                : "Shift+Enter starts a new line"}
          </p>
          <button type="submit" className="button button-primary button-small" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

/** The buttons for the open question's answers, or the field for the Secret asked for, on the message that asked. */
interface Answers {
  /** The open question's ID. An earlier question in the same message shows no buttons or field. */
  question: string;
  disabled: boolean;
  pick: (choice: string) => void;
  addSecret: (name: string, value: string) => Promise<void>;
}

function MessageItem({ message, turnRunning, answers }: { message: ConversationMessage; turnRunning: boolean; answers: Answers | null }) {
  const texts = message.parts.filter(isTextUIPart);
  const { metadata } = message;

  if (message.role === "user" && metadata?.from === "check") {
    return (
      <li className="conversation-notice">
        <p>{describeRetry(metadata.retry)}</p>
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
    // Adding a Secret the Agent asked for starts a Turn with the platform's note, which is said from `addedSecret` instead.
    const addedSecret = metadata?.from === "developer" ? metadata.addedSecret : undefined;
    return (
      <li className="conversation-item from-developer">
        <span className="speaker">You</span>
        <p className="conversation-text">{addedSecret === undefined ? texts[0]?.text : `Added the secret ${addedSecret}`}</p>
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

  const blocks = agentMessageBlocks(message.parts);
  if (blocks.length === 0) return null;
  return (
    <li className="conversation-item from-agent">
      <span className="speaker">Agent</span>
      {blocks.map((block, index) => {
        if (block.kind === "text") return <Markdown key={index} text={block.text} streaming={block.streaming} />;
        if (block.kind === "steps") return <Steps key={index} steps={block.steps} tools={block.tools} turnRunning={turnRunning} />;
        if (block.kind === "question") {
          const { question } = block;
          return question.asked === "secret" ? (
            <SecretRequest key={index} request={question} answers={answers} />
          ) : (
            <AgentQuestion key={index} question={question} answers={answers} />
          );
        }
        return (
          <p key={index} className="conversation-thinking">
            Thinking…
          </p>
        );
      })}
    </li>
  );
}

/** The Agent's steps in plain words, ticked off as it goes, with the tool calls behind them folded away. */
function Steps({ steps, tools, turnRunning }: { steps: Step[]; tools: ToolPart[]; turnRunning: boolean }) {
  return (
    <div className="agent-steps">
      {steps.length > 0 && <StepList steps={steps} />}
      {tools.length > 0 && (
        <details className="technical-details">
          <summary>Technical details</summary>
          {tools.map((part) => (
            <ToolLine key={part.toolCallId} part={part} turnRunning={turnRunning} />
          ))}
        </details>
      )}
    </div>
  );
}

/** A question the Agent asked, with its answers as buttons while it's open. The Developer can type an answer instead. */
function AgentQuestion({ question, answers }: { question: Extract<Question, { asked: "question" }>; answers: Answers | null }) {
  const questionId = useId();
  return (
    <div className="agent-question">
      <p id={questionId}>{question.question}</p>
      {answers?.question === question.id && (
        <div className="question-choices" role="group" aria-labelledby={questionId}>
          {question.choices.map((choice) => (
            <button key={choice} type="button" className="button button-small question-choice" disabled={answers.disabled} onClick={() => answers.pick(choice)}>
              {choice}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Agent asking for a Secret: why the app needs it, and while it's open, a
 * field that saves the value as a Secret through the Secrets route, so the
 * value never enters the Conversation (ADR 0016). Saving starts the next Turn.
 */
function SecretRequest({ request, answers }: { request: Extract<Question, { asked: "secret" }>; answers: Answers | null }) {
  const fieldId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<ApiError | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!answers) return;
    setError(null);
    try {
      await answers.addSecret(request.name, value);
      setValue("");
    } catch (caught) {
      setError(toApiError(caught));
    }
  }

  return (
    <div className="agent-question">
      <p>{request.why}</p>
      {answers?.question === request.id && (
        <form className="field" onSubmit={(event) => void save(event)}>
          <label htmlFor={fieldId}>{request.name}</label>
          <div className="secret-request-field">
            <input
              id={fieldId}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <button type="submit" className="button button-primary" disabled={answers.disabled || !value}>
              Save
            </button>
          </div>
          <p className="hint">Only your app can read it. It isn't kept in the chat, and the Agent never sees it.</p>
          {error && <ErrorMessage error={error} />}
        </form>
      )}
    </div>
  );
}

/** Steps, each ticked off when it's done. Also the first build's list of steps done. */
export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="step-list">
      {steps.map((step, index) => (
        <li key={index} className={step.done ? "step step-done" : "step"}>
          <span className="step-mark" aria-hidden="true">
            {step.done ? "✓" : "○"}
          </span>
          <span className="visually-hidden">{step.done ? "Done: " : "To do: "}</span>
          {step.label}
        </li>
      ))}
    </ul>
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
  // The page calls the end-of-Turn Check, Build and tests "making sure it works" (ADR 0018).
  else if (startedAt !== undefined) status = state?.turn?.stage === "checking" ? "Making sure it works…" : "The Agent is working…";
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
