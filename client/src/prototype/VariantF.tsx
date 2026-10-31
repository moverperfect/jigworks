// PROTOTYPE, throwaway. Variant F, "Fridge door": the interface is the surface these apps used to live on.
// What you say is a yellow note you've stuck up; the Agent answers in ink straight onto the door; your app
// is a sheet of paper pinned on the right. A's start page, then B's split, restyled from scratch.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CodePeek } from "./CodePeek";
import { FakeApp } from "./FakeApp";
import {
  appUrl,
  hasUnpublishedChanges,
  ideas,
  latestAgentMessage,
  type AgentMessage,
  type Sim,
  type SimState,
  type Step,
} from "./simulation";
import "./VariantF.css";

type Device = "phone" | "computer";
type Tab = "chat" | "app";

/** Where the first note was when it was sent, so the split can slide it into the chat column. */
type Handoff = { current: DOMRect | null };

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Notes alternate their tilt down the conversation; the start page's big note is the first. */
const tiltOf = (index: number) => (index % 2 === 0 ? -1.5 : 1.5);
const tilted = (degrees: number) => ({ "--vf-tilt": `${degrees}deg` }) as CSSProperties;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export function VariantF({ sim }: { sim: Sim }) {
  const { state } = sim;
  const handoff = useRef<DOMRect | null>(null);
  // The phase stays "start" for a moment after the first send, so the note itself decides the layout.
  if (state.phase === "start" && state.messages.length === 0) {
    return (
      <StartPage
        onStart={(text, from) => {
          handoff.current = from;
          sim.start(text);
        }}
      />
    );
  }
  return <Split sim={sim} handoff={handoff} />;
}

/* The start page: one big note in the middle of the door. */

function StartPage({ onStart }: { onStart(text: string, from: DOMRect): void }) {
  const [text, setText] = useState("");
  const [lifted, setLifted] = useState<string | null>(null);

  /** Lift the note off the door for a beat, then hand it over with where it was. */
  function stick(message: string, note: HTMLElement, key: string) {
    if (lifted) return;
    if (reducedMotion()) {
      onStart(message, note.getBoundingClientRect());
      return;
    }
    setLifted(key);
    window.setTimeout(() => onStart(message, note.getBoundingClientRect()), 150);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // An empty note: put the cursor on it rather than greying the button.
    if (!text.trim()) {
      event.currentTarget.querySelector("textarea")?.focus();
      return;
    }
    stick(text.trim(), event.currentTarget, "composer");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="vf vf-start">
      <header className="vf-head">
        <span className="vf-wordmark">Jigworks</span>
      </header>
      <div className="vf-door">
        <form className={`vf-note vf-note-big${lifted === "composer" ? " vf-lifted" : ""}`} style={tilted(tiltOf(0))} onSubmit={submit}>
          <label className="vf-question" htmlFor="vf-start-text">
            What would you like to make?
          </label>
          <textarea
            id="vf-start-text"
            rows={3}
            value={text}
            placeholder="A booking page for the village hall"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="vf-note-foot">
            <button type="submit" className="vf-button vf-button-ink">
              Make it
            </button>
          </div>
        </form>

        <ul className="vf-ideas" aria-label="Some ideas">
          {ideas.map((idea, index) => (
            <li key={idea}>
              <button
                type="button"
                className={`vf-note vf-note-small${lifted === idea ? " vf-lifted" : ""}`}
                style={tilted([2, -2, 1.5][index] ?? 0)}
                onClick={(event) => stick(idea, event.currentTarget, idea)}
              >
                {idea}
              </button>
            </li>
          ))}
        </ul>

        <section className="vf-apps" aria-labelledby="vf-apps-heading">
          <h2 id="vf-apps-heading">Your apps</h2>
          <ul>
            <li>
              <span className="vf-apps-name">Bake sale orders</span>
              <span className="vf-live">Live</span>
              <span className="vf-small">changed yesterday</span>
            </li>
            <li>
              <span className="vf-apps-name">Allotment rota</span>
              <span className="vf-muted">Not published</span>
              <span className="vf-small">changed 3 weeks ago</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/* The working layout: the conversation on the left, your app pinned on the right. */

function Split({ sim, handoff }: { sim: Sim; handoff: Handoff }) {
  const { state } = sim;
  const [device, setDevice] = useState<Device>("computer");
  const [showCode, setShowCode] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  // Whether this layout opened by the first note's hand-off, so the canvas slides open once.
  const [arriving] = useState(() => handoff.current !== null);
  const seenVersion = useRef(state.version);

  // On a phone, show the app when a Build lands.
  useEffect(() => {
    if (state.version > seenVersion.current) setTab("app");
    seenVersion.current = state.version;
  }, [state.version]);

  const unpublished = hasUnpublishedChanges(state);
  const publishLabel = !state.published ? "Publish" : unpublished ? "Publish changes" : "Share";

  return (
    <div className={`vf vf-split${arriving ? " vf-arriving" : ""}`}>
      <header className="vf-head">
        <span className="vf-wordmark">Jigworks</span>
        <span className="vf-app-title">{state.appName ?? "Your new app"}</span>
        <PublishStatus state={state} />
        <button type="button" className="vf-button vf-button-press vf-publish" disabled={!state.app} onClick={() => setPublishing(true)}>
          {publishLabel}
        </button>
      </header>

      <div className="vf-tabs" role="tablist" aria-label="Chat and app">
        {(["chat", "app"] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="vf-tab" onClick={() => setTab(key)}>
            {key === "chat" ? "Chat" : "App"}
          </button>
        ))}
      </div>

      <div className="vf-body" data-tab={tab}>
        <Chat sim={sim} handoff={handoff} />
        <Canvas
          sim={sim}
          device={device}
          onDevice={setDevice}
          showCode={showCode}
          onToggleCode={() => setShowCode((shown) => !shown)}
        />
      </div>

      {publishing && <PublishSheet sim={sim} onClose={() => setPublishing(false)} />}
    </div>
  );
}

function PublishStatus({ state }: { state: SimState }) {
  if (!state.published) return <span className="vf-status-word">Not published</span>;
  if (hasUnpublishedChanges(state)) return <span className="vf-status-word vf-status-word-changed">Live, with changes not yet published</span>;
  return <span className="vf-status-word vf-status-word-live">Live</span>;
}

/* The conversation: your notes, the Agent's ink. */

function Chat({ sim, handoff }: { sim: Sim; handoff: Handoff }) {
  const { state } = sim;
  const scroller = useRef<HTMLDivElement>(null);
  const firstNote = useRef<HTMLLIElement>(null);
  // In the split, "start" only lasts the moment between the first note and the Agent picking it up.
  const working = state.phase === "working" || state.phase === "planning" || state.phase === "start";
  const latest = latestAgentMessage(state);
  const yourCount = state.messages.filter((message) => message.from === "you").length;

  // The hand-off: the note you sent slides from where it was on the door into its place here.
  useLayoutEffect(() => {
    const from = handoff.current;
    handoff.current = null;
    const note = firstNote.current;
    if (!from || !note || reducedMotion()) return;
    const to = note.getBoundingClientRect();
    note.animate(
      [
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) rotate(${tiltOf(0)}deg)` },
        { transform: `rotate(${tiltOf(0)}deg)` },
      ],
      { duration: 350, easing: "cubic-bezier(0.45, 0, 0.2, 1)" },
    );
  }, [handoff]);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.suggestions]);

  let placeholder = "Ask for a change…";
  if (working) placeholder = "The Agent is working…";
  else if (state.pendingQuestion) placeholder = "Or write an answer…";

  let yourIndex = -1;
  return (
    <section className="vf-chat" aria-label="Conversation">
      <div ref={scroller} className="vf-chat-scroll">
        <ol className="vf-messages">
          {state.messages.map((message) => {
            if (message.from === "you") {
              yourIndex += 1;
              return (
                <li key={message.id} ref={yourIndex === 0 ? firstNote : undefined} className="vf-note vf-you" style={tilted(tiltOf(yourIndex))}>
                  {message.pointedAt && <span className="vf-about">About {message.pointedAt}</span>}
                  {message.text}
                </li>
              );
            }
            return <AgentInk key={message.id} message={message} isLatest={message.id === latest?.id} sim={sim} />;
          })}
        </ol>
        {state.suggestions.length > 0 && <Picks options={state.suggestions} onPick={(text) => sim.send(text)} />}
      </div>
      <div className="vf-chat-foot">
        <ComposerNote disabled={working} placeholder={placeholder} tilt={tiltOf(yourCount)} onSend={(text) => sim.send(text)} />
      </div>
    </section>
  );
}

function AgentInk({ message, isLatest, sim }: { message: AgentMessage; isLatest: boolean; sim: Sim }) {
  const { state } = sim;
  const [intro, ...rest] = message.text.split("\n\n");
  return (
    <li className={`vf-agent${message.failed ? " vf-agent-failed" : ""}`}>
      {message.failed && <p className="vf-failed-line">That didn't work. Your app hasn't changed.</p>}
      {intro && <p>{intro}</p>}
      {message.steps.length > 0 && (
        <>
          <Steps steps={message.steps} />
          <details className="vf-technical">
            <summary>Technical details</summary>
            <ul>
              {message.steps.map((step, index) => (
                <li key={index}>{step.detail}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {rest.map((paragraph, index) => (paragraph ? <p key={index}>{paragraph}</p> : null))}
      {message.choices && isLatest && state.pendingQuestion && <Picks options={message.choices} onPick={(text) => sim.send(text)} />}
    </li>
  );
}

/** What a step says on its line: the plain label, then what it decided. */
function stepText(step: Step, todo = false): string {
  if (step.status === "running") return `${step.label}…`;
  if (todo && step.result && step.label === "Choosing a starting point") return `Starting point: ${step.result}`;
  if (todo && step.result && step.label === "Naming your app") return `Name: ${step.result}`;
  return step.result ? `${step.label}: ${step.result}` : step.label;
}

function Steps({ steps, todo = false }: { steps: Step[]; todo?: boolean }) {
  return (
    <ul className={`vf-steps${todo ? " vf-steps-todo" : ""}`}>
      {steps.map((step, index) => (
        <li key={index} className={`vf-step vf-step-${step.status}`}>
          <span className="vf-box" aria-hidden="true">
            {step.status === "done" ? "✓" : step.status === "failed" ? "✕" : ""}
          </span>
          <span>
            {stepText(step, todo)}
            {step.status === "failed" && <span className="vf-hidden"> (failed)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Small notes to pick from: the Agent's suggestions, or its answers to a question. Tapping one makes it yours. */
function Picks({ options, onPick }: { options: string[]; onPick(text: string): void }) {
  return (
    <ul className="vf-picks">
      {options.map((option, index) => (
        <li key={option}>
          <button type="button" className="vf-note vf-pick" style={tilted(index % 2 === 0 ? -2 : 2)} onClick={() => onPick(option)}>
            {option}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ComposerNote({
  disabled,
  placeholder,
  tilt,
  onSend,
}: {
  disabled: boolean;
  placeholder: string;
  tilt: number;
  onSend(text: string): void;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (disabled) return;
    if (!text.trim()) {
      area.current?.focus();
      return;
    }
    onSend(text.trim());
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  return (
    <form className={`vf-note vf-composer${disabled ? " vf-composer-waiting" : ""}`} style={tilted(tilt)} onSubmit={send}>
      <textarea
        ref={area}
        aria-label="Ask for a change"
        rows={2}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="vf-button vf-button-ink" disabled={disabled}>
        Send
      </button>
    </form>
  );
}

/* The canvas: a sheet of paper pinned to the door. */

function Canvas({
  sim,
  device,
  onDevice,
  showCode,
  onToggleCode,
}: {
  sim: Sim;
  device: Device;
  onDevice(device: Device): void;
  showCode: boolean;
  onToggleCode(): void;
}) {
  const { state } = sim;
  const working = state.phase === "working";
  const failed = latestAgentMessage(state)?.failed === true;
  const hasApp = state.app !== null;
  const unpublished = hasUnpublishedChanges(state);

  let status: ReactNode;
  let tone = "";
  if (working && hasApp) {
    status = `Updating: ${lowerFirst(state.activity ?? "thinking…")}`;
    tone = "vf-status-working";
  } else if (failed) {
    status = hasApp ? "That didn't work. Your app hasn't changed." : "That didn't work. Ask the Agent to try again.";
    tone = "vf-status-failed";
  } else if (!state.published) status = "Only you can see this until you publish";
  else if (unpublished) status = "People with the link have the earlier version.";
  else {
    status = `Live at ${appUrl}`;
    tone = "vf-status-live";
  }

  return (
    <section className="vf-canvas" aria-label="Your app">
      <div className="vf-toolbar">
        <div role="group" aria-label="Show it on">
          {(["phone", "computer"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="vf-view"
              aria-pressed={device === option && !showCode}
              disabled={!hasApp}
              onClick={() => {
                onDevice(option);
                if (showCode) onToggleCode();
              }}
            >
              {option === "phone" ? "Phone" : "Computer"}
            </button>
          ))}
        </div>
        <button type="button" className="vf-button-text vf-open" disabled={!hasApp}>
          Open in a new tab
        </button>
        <span className="vf-toolbar-space" />
        <button type="button" className="vf-button-text" aria-pressed={showCode} disabled={!hasApp} onClick={onToggleCode}>
          See the code
        </button>
      </div>

      <p className={`vf-status ${tone}`} role="status">
        <span>{status}</span>
        {working && hasApp && state.progress && (
          <span className="vf-progress" aria-hidden="true">
            <span style={{ width: `${(state.progress.done / state.progress.total) * 100}%` }} />
          </span>
        )}
      </p>

      <div className={`vf-stage vf-stage-${device}`}>
        {showCode && hasApp ? (
          <div className="vf-sheet vf-sheet-code">
            <CodePeek onClose={onToggleCode} />
          </div>
        ) : hasApp ? (
          <div className="vf-sheet vf-sheet-app">
            <FakeApp features={state.app!} />
          </div>
        ) : (
          <TodoSheet state={state} />
        )}
      </div>
    </section>
  );
}

/** The first build: a to-do list written on the sheet where the app will be. */
function TodoSheet({ state }: { state: SimState }) {
  const latest = latestAgentMessage(state);
  const steps = latest?.steps ?? [];
  const failed = latest?.failed === true;
  const progress = state.progress;
  let title = "Getting started…";
  if (state.phase === "working") title = state.activity ?? "Thinking…";
  else if (failed) title = "That didn't work";
  return (
    <div className="vf-sheet vf-sheet-todo">
      <h2 className="vf-todo-title">{title}</h2>
      {steps.length > 0 && <Steps steps={steps} todo />}
      <p className="vf-todo-count">
        {progress ? `${progress.done} of ${progress.total} things done` : failed ? "Nothing's been made yet. Ask the Agent to try again." : ""}
      </p>
    </div>
  );
}

/* Publishing: a sheet lifted in front of the door. */

function PublishSheet({ sim, onClose }: { sim: Sim; onClose(): void }) {
  const { state } = sim;
  const unpublished = hasUnpublishedChanges(state);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copy() {
    void navigator.clipboard?.writeText(appUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="vf-backdrop" onClick={onClose}>
      <div className="vf-sheet vf-dialog" role="dialog" aria-modal="true" aria-label="Publish" onClick={(event) => event.stopPropagation()}>
        {!state.published && (
          <>
            <h2>Publish {state.appName}?</h2>
            <p>
              Anyone with the link will be able to use it: <strong>{appUrl}</strong>
            </p>
            <p className="vf-muted">You can keep changing it here. People see your changes only when you publish again.</p>
            <div className="vf-dialog-actions">
              <button type="button" className="vf-button vf-button-plain" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="vf-button vf-button-press" onClick={sim.publish}>
                Publish
              </button>
            </div>
          </>
        )}
        {state.published && unpublished && (
          <>
            <h2>Publish your changes?</h2>
            <p>People using the link have the earlier version. Publishing gives them this one.</p>
            <div className="vf-dialog-actions">
              <button type="button" className="vf-button vf-button-plain" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="vf-button vf-button-press" onClick={sim.publish}>
                Publish changes
              </button>
            </div>
          </>
        )}
        {state.published && !unpublished && (
          <>
            <h2>{state.appName} is live</h2>
            <p className="vf-dialog-link">{appUrl}</p>
            <div className="vf-dialog-actions">
              <button type="button" className="vf-button vf-button-plain" onClick={copy}>
                {copied ? "Copied" : "Copy the link"}
              </button>
              <button type="button" className="vf-button vf-button-press" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
