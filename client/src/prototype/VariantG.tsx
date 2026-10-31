// PROTOTYPE, throwaway. Variant G, "Stage directions": the Conversation set as a play script.
// Speaker names on their own line, dialogue beneath, and what the Agent does as italic stage
// directions in parentheses. No bubbles, cards or boxes anywhere; the app sits on the right like
// a plate in a book, with an italic caption under it that tells every canvas state.
// A's start page, then B's split, restyled from DESIGN-DIRECTIONS.md, Direction 3.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
import "./VariantG.css";

type Handoff = "none" | "leaving" | "arriving";
type Device = "phone" | "computer";
type Tab = "chat" | "app";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A link inside a sentence. An anchor, so its words wrap like the sentence's own. */
function Link({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <a
      href="#"
      className="vg-link"
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
    >
      {children}
    </a>
  );
}

export function VariantG({ sim }: { sim: Sim }) {
  const { state } = sim;
  const [handoff, setHandoff] = useState<Handoff>("none");
  // The start page stays while it fades out, even though the first message has already landed.
  const showStart = (state.phase === "start" && state.messages.length === 0) || handoff === "leaving";

  function begin(text: string) {
    if (handoff !== "none") return;
    sim.start(text);
    if (reducedMotion()) {
      setHandoff("arriving");
      return;
    }
    setHandoff("leaving");
    window.setTimeout(() => setHandoff("arriving"), 200);
  }

  useEffect(() => {
    if (handoff !== "arriving") return;
    const timer = window.setTimeout(() => setHandoff("none"), 400);
    return () => window.clearTimeout(timer);
  }, [handoff]);

  return (
    <div className="vg">
      {showStart ? (
        <Start leaving={handoff === "leaving"} onStart={begin} />
      ) : (
        <Split sim={sim} arriving={handoff === "arriving"} />
      )}
    </div>
  );
}

/* The start page: the question, a line to write on, the examples as a sentence, and Your apps. */

function Start({ leaving, onStart }: { leaving: boolean; onStart(text: string): void }) {
  return (
    <div className={`vg-page vg-start${leaving ? " vg-leaving" : ""}`}>
      <header className="vg-head vg-head-start">
        <span className="vg-wordmark">Jigworks</span>
      </header>
      <div className="vg-start-scroll">
        <main className="vg-start-column">
          <h1 className="vg-question">What would you like to make?</h1>
          <p className="vg-lede">Say it in your own words. The Agent builds it, and you can change anything by asking.</p>
          <Composer
            big
            placeholder="A booking page for the village hall"
            sendLabel="Make it"
            onSend={onStart}
          />
          <p className="vg-examples">
            For example,
            <br />
            {ideas.map((idea, index) => (
              <span key={idea} className="vg-example">
                {index === ideas.length - 1 && "or "}
                <Link onClick={() => onStart(idea)}>{lowerFirst(idea)}</Link>
                {index < ideas.length - 1 ? "," : "."}
                <br />
              </span>
            ))}
          </p>
          <section className="vg-yours" aria-labelledby="vg-yours-heading">
            <h2 id="vg-yours-heading" className="vg-yours-heading">
              Your apps
            </h2>
            <ul className="vg-yours-list">
              <YourApp name="Bake sale orders" status="Live" live changed="changed yesterday" />
              <YourApp name="Allotment rota" status="Not published" changed="changed 3 weeks ago" />
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}

function YourApp({ name, status, live = false, changed }: { name: string; status: string; live?: boolean; changed: string }) {
  return (
    <li className="vg-yours-item">
      <button type="button" className="vg-yours-row">
        <span className="vg-yours-name">{name}</span>
        <span className="vg-leader" aria-hidden="true" />
        <span className={`vg-yours-status${live ? " vg-live" : ""}`}>{status}</span>
      </button>
      <span className="vg-yours-changed">{changed}</span>
    </li>
  );
}

/* The working layout: the running head, the script on the left, the plate on the right. */

function Split({ sim, arriving }: { sim: Sim; arriving: boolean }) {
  const { state } = sim;
  const [device, setDevice] = useState<Device>("computer");
  const [showCode, setShowCode] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const seenVersion = useRef(state.version);

  // On a narrow screen, show the app when a Build lands.
  useEffect(() => {
    if (state.version > seenVersion.current) setTab("app");
    seenVersion.current = state.version;
  }, [state.version]);

  const unpublished = hasUnpublishedChanges(state);
  let publishLabel = "Publish";
  if (state.published) publishLabel = unpublished ? "Publish changes" : "Share";

  return (
    <div className={`vg-page vg-split${arriving ? " vg-arriving" : ""}`} data-tab={tab}>
      <header className="vg-head vg-head-split">
        <span className="vg-wordmark">Jigworks</span>
        <span className={`vg-title${state.appName ? "" : " vg-muted"}`}>{state.appName ?? "Your new app"}</span>
        <span className="vg-head-right">
          <Status state={state} />
          <button type="button" className="vg-button vg-publish" disabled={!state.app} onClick={() => setPublishing(true)}>
            {publishLabel}
          </button>
        </span>
      </header>

      <div className="vg-tabs" role="tablist" aria-label="Conversation and app">
        {(["chat", "app"] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="vg-tab" onClick={() => setTab(key)}>
            {key === "chat" ? "Conversation" : "The app"}
          </button>
        ))}
      </div>

      <div className="vg-body">
        <Conversation sim={sim} />
        <Canvas
          sim={sim}
          device={device}
          onDevice={setDevice}
          showCode={showCode}
          onToggleCode={() => setShowCode((shown) => !shown)}
        />
      </div>

      {publishing && <PublishPanel sim={sim} onClose={() => setPublishing(false)} />}
    </div>
  );
}

function Status({ state }: { state: SimState }) {
  if (!state.published) return <span className="vg-status vg-muted">Not published</span>;
  if (hasUnpublishedChanges(state)) return <span className="vg-status">Live, with changes not yet published</span>;
  return <span className="vg-status vg-live">Live</span>;
}

/* The script. */

function Conversation({ sim }: { sim: Sim }) {
  const { state } = sim;
  const scroller = useRef<HTMLDivElement>(null);
  const working = state.phase === "working" || state.phase === "planning";
  const latest = latestAgentMessage(state);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.suggestions]);

  let placeholder = "Ask for a change…";
  if (working) placeholder = "The Agent is working…";
  else if (state.pendingQuestion) placeholder = "Or write an answer…";

  return (
    <section className="vg-chat" aria-label="Conversation">
      <div ref={scroller} className="vg-script">
        {state.messages.map((message) =>
          message.from === "you" ? (
            <div key={message.id} className="vg-turn">
              <p className="vg-speaker">You</p>
              {message.pointedAt && <p className="vg-direction vg-muted">(Pointing at {message.pointedAt}.)</p>}
              <p className="vg-line vg-line-you">{message.text}</p>
            </div>
          ) : (
            <AgentTurn key={message.id} message={message} sim={sim} isLatest={message.id === latest?.id} />
          ),
        )}
        {state.suggestions.length > 0 && (
          <div className="vg-turn vg-offers">
            <p className="vg-direction">You might say</p>
            <ul className="vg-offer-list">
              {state.suggestions.map((suggestion, index, all) => (
                <li key={suggestion} className="vg-direction">
                  <Link onClick={() => sim.send(suggestion)}>{suggestion}</Link>
                  {index === all.length - 1 ? "." : index === all.length - 2 ? ", or" : ","}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <Composer disabled={working} placeholder={placeholder} sendLabel="Send" onSend={(text) => sim.send(text)} />
    </section>
  );
}

function AgentTurn({ message, sim, isLatest }: { message: AgentMessage; sim: Sim; isLatest: boolean }) {
  const { state } = sim;
  const [technical, setTechnical] = useState(false);
  const [intro, ...rest] = message.text.split("\n\n");
  const askable = message.choices && isLatest && state.pendingQuestion !== null;

  return (
    <div className="vg-turn">
      <p className="vg-speaker vg-speaker-agent">Agent</p>
      {intro && <p className="vg-line">{intro}</p>}
      {message.steps.length > 0 && (
        <>
          <ul className="vg-directions">
            {message.steps.map((step, index) => (
              <li key={index} className={`vg-direction vg-direction-${step.status}`}>
                {direction(step)}
              </li>
            ))}
          </ul>
          <button type="button" className="vg-technical-toggle" aria-expanded={technical} onClick={() => setTechnical((shown) => !shown)}>
            Technical details
          </button>
          {technical && (
            <ul className="vg-directions vg-technical">
              {message.steps.map((step, index) => (
                <li key={index} className="vg-direction vg-direction-done">
                  ({sentence(step.detail)})
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {rest.map((paragraph, index) => (paragraph ? <p key={index} className="vg-line">{paragraph}</p> : null))}
      {askable && (
        <>
          <p className="vg-direction">(choose one)</p>
          <div className="vg-choices">
            {message.choices!.map((choice) => (
              <button key={choice} type="button" className="vg-outline" onClick={() => sim.send(choice)}>
                {choice}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** One step as a stage direction, in parentheses. */
function direction(step: Step): string {
  switch (step.status) {
    case "running":
      return `(${step.label}…)`;
    case "fixing":
      return `(${(step.result ?? "Found a problem, fixing it").replace(/ \((try \d of \d)\)$/, ", $1")}…)`;
    case "failed":
      return "(Couldn't fix it after three tries. Your app hasn't changed.)";
    case "done":
      if (!step.result) return `(${step.label}.)`;
      return `(${step.label}: ${step.label === "Naming your app" ? step.result : lowerFirst(step.result)}.)`;
  }
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/* The composer: a line to write on. */

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

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (disabled || !text.trim()) return;
    onSend(text.trim());
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  return (
    <form className={`vg-composer${big ? " vg-composer-big" : ""}`} onSubmit={send}>
      <textarea
        className="vg-field"
        aria-label="Message to the Agent"
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className={big ? "vg-button" : "vg-text-button"} disabled={disabled || !text.trim()}>
        {sendLabel}
      </button>
    </form>
  );
}

/* The plate: the app on the right, with its caption. */

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
  const lastActivity = useRef("Making sure it works…");
  if (state.activity) lastActivity.current = state.activity;

  // When the first Build lands, the activity line fades as the plate appears. A Build lands from
  // the Turn's last stretch (phase "working", the outro typing, no activity); a jump from the
  // floating bar doesn't count, so the sheets show the moment, not the fade.
  const [ghost, setGhost] = useState<string | null>(null);
  const previous = useRef({ app: state.app !== null, landing: false });
  useEffect(() => {
    const has = state.app !== null;
    const { app: had, landing } = previous.current;
    previous.current = { app: has, landing: state.phase === "working" && state.activity === null };
    if (has && !had && landing && !reducedMotion()) {
      setGhost(lastActivity.current);
      const timer = window.setTimeout(() => setGhost(null), 260);
      return () => window.clearTimeout(timer);
    }
  }, [state.app, state.phase, state.activity]);

  const progress = state.progress ? Math.max(0.04, state.progress.done / state.progress.total) : 0.04;

  if (!state.app) {
    return (
      <section className="vg-canvas" aria-label="Your app">
        <div className="vg-building" role="status">
          {failed && !working ? (
            <p className="vg-caption vg-caption-failed">That didn't work. Nothing to show yet.</p>
          ) : (
            <>
              <p className="vg-activity">{state.activity ?? "Thinking…"}</p>
              <ProgressRule fraction={progress} />
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="vg-canvas" aria-label="Your app">
      <div className="vg-toolbar">
        {(["phone", "computer"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="vg-view"
            aria-pressed={device === option && !showCode}
            onClick={() => {
              onDevice(option);
              if (showCode) onToggleCode();
            }}
          >
            {option === "phone" ? "Phone" : "Computer"}
          </button>
        ))}
        <button type="button" className="vg-quiet vg-new-tab">
          Open in a new tab
        </button>
        <span className="vg-space" />
        <button type="button" className="vg-quiet" aria-pressed={showCode} onClick={onToggleCode}>
          See the code
        </button>
      </div>

      <figure className={`vg-plate vg-plate-${showCode ? "computer" : device}${ghost ? " vg-appearing" : ""}`}>
        <div className="vg-frame">{showCode ? <CodePeek onClose={onToggleCode} /> : <FakeApp features={state.app} />}</div>
        <Caption state={state} showCode={showCode} failed={failed} />
        {working && !showCode && <ProgressRule fraction={progress} />}
      </figure>

      {ghost && (
        <p className="vg-activity vg-ghost" aria-hidden="true">
          {ghost}
        </p>
      )}
    </section>
  );
}

function ProgressRule({ fraction }: { fraction: number }) {
  return (
    <span className="vg-progress" aria-hidden="true">
      <span className="vg-progress-done" style={{ width: `${fraction * 100}%` }} />
    </span>
  );
}

function Caption({ state, showCode, failed }: { state: SimState; showCode: boolean; failed: boolean }) {
  const [copied, setCopied] = useState(false);
  let tone = "";
  let text: ReactNode;

  if (showCode) text = "The code, for anyone who wants it.";
  else if (state.phase === "working") {
    tone = " vg-caption-plum";
    text = `Updating: ${lowerFirst(state.activity ?? "thinking…")}`;
  } else if (failed) {
    tone = " vg-caption-failed";
    text = "That didn't work. Your app is as it was.";
  } else if (!state.published) text = "Only you can see this until you publish.";
  else if (hasUnpublishedChanges(state))
    text = `People with the link have the version from ${time(state.published.at)}. Publish to give them this one.`;
  else
    text = (
      <>
        Published {day(state.published.at)} at {time(state.published.at)}. Anyone with the link can use it:{" "}
        <span className="vg-url">{appUrl}</span>{" "}
        <Link
          onClick={() => {
            void navigator.clipboard?.writeText(appUrl);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy the link"}
        </Link>
      </>
    );

  return <figcaption className={`vg-caption${tone}`}>{text}</figcaption>;
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "long" });
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/* The publish panel: the shared copy, framed by one Rule. */

function PublishPanel({ sim, onClose }: { sim: Sim; onClose(): void }) {
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

  return (
    <div className="vg-veil" onClick={onClose}>
      <div className="vg-panel" role="dialog" aria-label="Publish" onClick={(event) => event.stopPropagation()}>
        {!state.published && (
          <>
            <h2 className="vg-panel-title">Publish {state.appName}?</h2>
            <p className="vg-line">
              Anyone with the link will be able to use it: <span className="vg-url">{appUrl}</span>
            </p>
            <p className="vg-line vg-muted">You can keep changing it here. People see your changes only when you publish again.</p>
            <div className="vg-panel-actions">
              <button type="button" className="vg-text-button" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="vg-button" onClick={sim.publish}>
                Publish
              </button>
            </div>
          </>
        )}
        {state.published && unpublished && (
          <>
            <h2 className="vg-panel-title">Publish your changes?</h2>
            <p className="vg-line">People using the link have the earlier version. Publishing gives them this one.</p>
            <div className="vg-panel-actions">
              <button type="button" className="vg-text-button" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="vg-button" onClick={sim.publish}>
                Publish changes
              </button>
            </div>
          </>
        )}
        {state.published && !unpublished && (
          <>
            <h2 className="vg-panel-title">{state.appName} is live</h2>
            <p className="vg-line vg-url">{appUrl}</p>
            <div className="vg-panel-actions">
              <button
                type="button"
                className="vg-text-button"
                onClick={() => {
                  void navigator.clipboard?.writeText(appUrl);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy the link"}
              </button>
              <button type="button" className="vg-button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
