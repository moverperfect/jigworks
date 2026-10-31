// PROTOTYPE, throwaway. Variant E, "On the bench": Jigworks is named after the jig, the frame that holds a piece
// steady on a workbench. The Agent is the jig, your app is the piece, publishing releases it. A's start page then
// B's split, restyled: Paper on a cutting Mat, pencil-grey Archivo, and four corner brackets whose posture
// (holding, working, released, held again, failed) tells what's happening to your app.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
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
import "./VariantE.css";

type Device = "phone" | "computer";
type Tab = "chat" | "app";
type Posture = "holding" | "working" | "released" | "failed";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The rectangle the brackets frame, measured from their outer corners, relative to the root. */
function bracketBox(jig: HTMLElement, root: HTMLElement): Box {
  const tl = jig.querySelector(".ve-corner-tl")?.getBoundingClientRect();
  const br = jig.querySelector(".ve-corner-br")?.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  if (!tl || !br) return { top: 0, left: 0, width: 0, height: 0 };
  return { top: tl.top - r.top, left: tl.left - r.left, width: br.right - tl.left, height: br.bottom - tl.top };
}

function place(element: HTMLElement, box: Box) {
  element.style.top = `${box.top}px`;
  element.style.left = `${box.left}px`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
}

export function VariantE({ sim }: { sim: Sim }) {
  const { state } = sim;
  // The sim keeps `phase: "start"` for 400 ms after the first message, so the split shows as soon as there's one.
  const onStart = state.phase === "start" && state.messages.length === 0;
  const root = useRef<HTMLDivElement>(null);
  const startJig = useRef<HTMLDivElement>(null);
  const canvasJig = useRef<HTMLDivElement>(null);
  const travelEl = useRef<HTMLDivElement>(null);
  // The hand-off: where the brackets leave from. They land on the canvas's jig once the split has rendered.
  const [travel, setTravel] = useState<Box | null>(null);

  function begin(text: string) {
    if (!reducedMotion() && startJig.current && root.current) setTravel(bracketBox(startJig.current, root.current));
    sim.start(text);
  }

  useLayoutEffect(() => {
    if (!travel || onStart) return;
    const overlay = travelEl.current;
    const target = canvasJig.current;
    if (!overlay || !target || !root.current) return setTravel(null);
    const to = bracketBox(target, root.current);
    // On a phone the canvas is behind the App tab, so there's nowhere to travel to.
    if (to.width === 0) return setTravel(null);
    place(overlay, travel);
    overlay.getBoundingClientRect();
    overlay.classList.add("ve-travel-go");
    place(overlay, to);
    const timer = window.setTimeout(() => setTravel(null), 460);
    return () => window.clearTimeout(timer);
  }, [travel, onStart]);

  useEffect(() => {
    if (onStart) setTravel(null);
  }, [onStart]);

  return (
    <div ref={root} className="ve">
      {onStart ? (
        <StartPage jigRef={startJig} onStart={begin} />
      ) : (
        <Split sim={sim} jigRef={canvasJig} travelling={travel !== null} />
      )}
      {travel && (
        <div ref={travelEl} className="ve-travel" aria-hidden="true">
          <Corners />
        </div>
      )}
    </div>
  );
}

function Corners() {
  return (
    <>
      {(["tl", "tr", "bl", "br"] as const).map((corner) => (
        <span key={corner} className={`ve-corner ve-corner-${corner}`} aria-hidden="true" />
      ))}
    </>
  );
}

function StartPage({ jigRef, onStart }: { jigRef: RefObject<HTMLDivElement | null>; onStart(text: string): void }) {
  return (
    <>
      <header className="ve-top">
        <span className="ve-wordmark">Jigworks</span>
      </header>
      <main className="ve-start">
        <div className="ve-start-column">
          <h1 className="ve-question">What would you like to make?</h1>
          <p className="ve-lede">Say it in your own words. The Agent builds it, and you can change anything by asking.</p>
          <div ref={jigRef} className="ve-jig ve-jig-holding ve-jig-composer">
            <Corners />
            <Composer big placeholder="A booking page for the village hall" sendLabel="Make it" onSend={onStart} />
          </div>
          <section className="ve-ideas" aria-labelledby="ve-ideas-heading">
            <h2 id="ve-ideas-heading" className="ve-note ve-ideas-heading">
              Or start from one of these
            </h2>
            <ul className="ve-list">
              {ideas.map((idea) => (
                <li key={idea}>
                  <button type="button" className="ve-text-button" onClick={() => onStart(idea)}>
                    {idea}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="ve-apps" aria-labelledby="ve-apps-heading">
            <h2 id="ve-apps-heading" className="ve-apps-heading">
              Your apps
            </h2>
            <ul className="ve-list ve-apps-list">
              <li>
                <span className="ve-apps-name">Bake sale orders</span>
                <span className="ve-note ve-apps-live">Live</span>
                <span className="ve-note ve-apps-when">changed yesterday</span>
              </li>
              <li>
                <span className="ve-apps-name">Allotment rota</span>
                <span className="ve-note ve-apps-status">Not published</span>
                <span className="ve-note ve-apps-when">changed 3 weeks ago</span>
              </li>
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}

interface Jig {
  posture: Posture;
  label: string;
  /** Whether the label carries the "Copy the link" button. */
  link?: boolean;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The brackets' posture and the one label at the top-left bracket. */
function jigFor(state: SimState, showCode: boolean): Jig {
  if (showCode) return { posture: "holding", label: "The code" };
  const busy = state.phase === "working" || state.phase === "start";
  if (busy) {
    if (!state.app) return { posture: "working", label: "Making your app" };
    return { posture: "working", label: `Updating: ${lowerFirst(state.activity ?? "getting ready…")}` };
  }
  if (latestAgentMessage(state)?.failed) {
    return { posture: "failed", label: state.app ? "That didn't work. Your app hasn't changed." : "That didn't work. Nothing's been made yet." };
  }
  if (state.published && !hasUnpublishedChanges(state)) return { posture: "released", label: `Live at ${appUrl}`, link: true };
  if (state.published) return { posture: "holding", label: "Changes not yet published. People with the link have the earlier version." };
  return { posture: "holding", label: "Only you can see this until you publish" };
}

function Split({ sim, jigRef, travelling }: { sim: Sim; jigRef: RefObject<HTMLDivElement | null>; travelling: boolean }) {
  const { state } = sim;
  const [device, setDevice] = useState<Device>("computer");
  const [showCode, setShowCode] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [copied, setCopied] = useState(false);
  const seenVersion = useRef(state.version);

  // On a phone, show the app when a Build lands.
  useEffect(() => {
    if (state.version > seenVersion.current) setTab("app");
    seenVersion.current = state.version;
  }, [state.version]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const unpublished = hasUnpublishedChanges(state);
  const publishLabel = !state.published ? "Publish" : unpublished ? "Publish changes" : "Share";
  const jig = jigFor(state, showCode);
  const busy = state.phase === "working" || state.phase === "start";

  function copyLink() {
    void navigator.clipboard?.writeText(appUrl).catch(() => undefined);
    setCopied(true);
  }

  const label = (
    <>
      <span>{jig.label}</span>
      {jig.link && (
        <button type="button" className="ve-text-button ve-copy" onClick={copyLink}>
          {copied ? "Copied" : "Copy the link"}
        </button>
      )}
    </>
  );

  return (
    <>
      <header className="ve-top ve-top-split">
        <span className="ve-wordmark">Jigworks</span>
        <span className="ve-appname">{state.appName ?? "Your new app"}</span>
        <span className={`ve-note ve-status${state.published ? (unpublished ? " ve-status-changed" : " ve-status-live") : ""}`}>
          {!state.published ? "Not published" : unpublished ? "Live, with changes not yet published" : "Live"}
        </span>
        <div className="ve-publish-wrap">
          <button
            type="button"
            className="ve-button ve-button-primary"
            disabled={!state.app}
            aria-expanded={publishing}
            onClick={() => setPublishing((open) => !open)}
          >
            {publishLabel}
          </button>
          {publishing && <PublishPopover sim={sim} onClose={() => setPublishing(false)} />}
        </div>
      </header>

      <div className="ve-tabs" role="tablist" aria-label="Chat and app">
        {(["chat", "app"] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="ve-tab" onClick={() => setTab(key)}>
            {key === "chat" ? "Chat" : "App"}
          </button>
        ))}
      </div>

      <div className="ve-body" data-tab={tab}>
        <ChatPane sim={sim} />
        <section className={`ve-canvas ve-canvas-${jig.posture}`} aria-label="Your app">
          <div className="ve-toolbar">
            <p className="ve-strip-label" role="status">
              {label}
            </p>
            <div className="ve-segmented" role="group" aria-label="Show it on">
              {(["phone", "computer"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={device === option && !showCode}
                  onClick={() => {
                    setDevice(option);
                    setShowCode(false);
                  }}
                >
                  {option === "phone" ? "Phone" : "Computer"}
                </button>
              ))}
            </div>
            <button type="button" className="ve-toolbar-button ve-toolbar-wide">
              Open in a new tab
            </button>
            <button
              type="button"
              className="ve-toolbar-button ve-toolbar-end"
              aria-pressed={showCode}
              onClick={() => setShowCode((shown) => !shown)}
            >
              See the code
            </button>
          </div>
          <div className="ve-bench">
            <div
              ref={jigRef}
              className={`ve-jig ve-jig-canvas ve-jig-${jig.posture} ve-jig-${device}${travelling ? " ve-jig-quiet" : ""}`}
            >
              <Corners />
              <p className="ve-jig-label" role="status">
                {label}
              </p>
              <div className={`ve-sheet${busy && state.app && !showCode ? " ve-sheet-dim" : ""}`}>
                {showCode ? (
                  <CodePeek onClose={() => setShowCode(false)} />
                ) : state.app ? (
                  <FakeApp features={state.app} />
                ) : (
                  <Building state={state} />
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/** What a finished step says on the building panel. */
function doneLine(step: Step): string {
  switch (step.label) {
    case "Choosing a starting point":
      return `Starting point: ${step.result ?? ""}`;
    case "Naming your app":
      return `Name: ${step.result ?? ""}`;
    case "Designing the sign-up page":
      return "Designed the sign-up page";
    case "Keeping track of who's coming":
      return "Keeps track of who's coming";
    case "Making sure it works":
      return "Checked it works";
    default:
      return step.label;
  }
}

/** The first build: the current activity, a progress rule, and what's done so far, on the Paper panel. */
function Building({ state }: { state: SimState }) {
  const latest = latestAgentMessage(state);
  const done = latest?.steps.filter((step) => step.status === "done") ?? [];
  const progress = state.progress;
  const title = state.activity ?? (latest?.failed ? "Nothing to show yet" : "Getting ready…");
  return (
    <div className="ve-building">
      <h2 className="ve-building-title" role="status">
        {title}
      </h2>
      {progress && (
        <div className="ve-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(2, (progress.done / progress.total) * 100)}%` }} />
        </div>
      )}
      <ul className="ve-list ve-note ve-building-steps">
        {done.map((step, index) => (
          <li key={index}>
            <span className="ve-glyph" aria-hidden="true">
              ✓
            </span>
            <span>{doneLine(step)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatPane({ sim }: { sim: Sim }) {
  const { state } = sim;
  const scroller = useRef<HTMLDivElement>(null);
  const busy = state.phase === "working" || state.phase === "start";
  const latest = latestAgentMessage(state);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.suggestions]);

  let placeholder = "Ask for a change…";
  if (busy) placeholder = "The Agent is working…";
  else if (state.pendingQuestion) placeholder = "Or type an answer…";

  return (
    <section className="ve-chat" aria-label="Conversation">
      <div ref={scroller} className="ve-chat-scroll">
        <ol className="ve-list ve-messages">
          {state.messages.map((message) =>
            message.from === "you" ? (
              <li key={message.id} className="ve-you">
                <span className="ve-note ve-speaker">You</span>
                <p>{message.text}</p>
              </li>
            ) : (
              <AgentItem key={message.id} message={message} sim={sim} isLatest={message.id === latest?.id} />
            ),
          )}
        </ol>
      </div>
      <div className="ve-chat-bottom">
        {state.suggestions.length > 0 && (
          <ul className="ve-list ve-suggestions">
            {state.suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button type="button" className="ve-text-button" onClick={() => sim.send(suggestion)}>
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
        <Composer disabled={busy} placeholder={placeholder} sendLabel="Send" onSend={(text) => sim.send(text)} />
      </div>
    </section>
  );
}

const glyphFor = (step: Step) =>
  step.status === "done" ? "✓" : step.status === "failed" ? "✕" : step.status === "fixing" ? "↻" : "◌";

function AgentItem({ message, sim, isLatest }: { message: AgentMessage; sim: Sim; isLatest: boolean }) {
  const { state } = sim;
  const [intro, ...rest] = message.text.split("\n\n");
  return (
    <li className="ve-agent">
      <span className="ve-note ve-speaker">Agent</span>
      {intro && <p>{intro}</p>}
      {message.steps.length > 0 && (
        <>
          <ul className="ve-list ve-note ve-steps">
            {message.steps.map((step, index) => (
              <li key={index} className={`ve-step ve-step-${step.status}`}>
                <span className="ve-glyph" aria-hidden="true">
                  {glyphFor(step)}
                </span>
                <span>
                  <span className="ve-step-label">{step.label}</span>
                  {step.result && <span className="ve-step-result">{step.result}</span>}
                </span>
              </li>
            ))}
          </ul>
          <details className="ve-note ve-technical">
            <summary>Technical details</summary>
            <ul className="ve-list">
              {message.steps.map((step, index) => (
                <li key={index}>{step.detail}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {rest.map((paragraph, index) => (paragraph ? <p key={index}>{paragraph}</p> : null))}
      {message.choices && isLatest && state.pendingQuestion && (
        <div className="ve-choices">
          {message.choices.map((choice) => (
            <button key={choice} type="button" className="ve-button ve-button-outline" onClick={() => sim.send(choice)}>
              {choice}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Composer({
  big = false,
  disabled = false,
  placeholder,
  sendLabel,
  onSend,
}: {
  big?: boolean;
  disabled?: boolean;
  placeholder: string;
  sendLabel: string;
  onSend(text: string): void;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (disabled) return;
    if (!text.trim()) return field.current?.focus();
    onSend(text.trim());
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  return (
    <form className={`ve-composer${big ? " ve-composer-big" : ""}`} onSubmit={send}>
      <textarea
        ref={field}
        aria-label="Message to the Agent"
        rows={big ? 3 : 2}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="ve-button ve-button-primary" disabled={disabled}>
        {sendLabel}
      </button>
    </form>
  );
}

function PublishPopover({ sim, onClose }: { sim: Sim; onClose(): void }) {
  const { state } = sim;
  const unpublished = hasUnpublishedChanges(state);
  return (
    <>
      <div className="ve-popover-backdrop" onClick={onClose} />
      <div className="ve-popover" role="dialog" aria-label="Publish">
        {!state.published && (
          <>
            <h2 className="ve-popover-title">Publish {state.appName}?</h2>
            <p>
              Anyone with the link will be able to use it: <span className="ve-url">{appUrl}</span>
            </p>
            <p className="ve-muted">You can keep changing it here. People see your changes only when you publish again.</p>
            <div className="ve-popover-actions">
              <button type="button" className="ve-button ve-button-quiet" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="ve-button ve-button-primary" onClick={sim.publish}>
                Publish
              </button>
            </div>
          </>
        )}
        {state.published && unpublished && (
          <>
            <h2 className="ve-popover-title">Publish your changes?</h2>
            <p>People using the link have the earlier version. Publishing gives them this one.</p>
            <div className="ve-popover-actions">
              <button type="button" className="ve-button ve-button-quiet" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="ve-button ve-button-primary" onClick={sim.publish}>
                Publish changes
              </button>
            </div>
          </>
        )}
        {state.published && !unpublished && (
          <>
            <h2 className="ve-popover-title">{state.appName} is live</h2>
            <p className="ve-url">{appUrl}</p>
            <div className="ve-popover-actions">
              <button type="button" className="ve-button ve-button-quiet" onClick={() => void navigator.clipboard?.writeText(appUrl)}>
                Copy the link
              </button>
              <button type="button" className="ve-button ve-button-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
