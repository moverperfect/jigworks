// PROTOTYPE, throwaway. Variant D, "Agree a plan, then build": before building anything, the Agent writes a plan
// in plain English for the person to check and tick. Once built, that plan stays as the app's living description,
// beside a list of changes, in place of a transcript. The Template shows in the plan as "How I'll build it", with a reason.
import { useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { CodePeek } from "./CodePeek";
import { FakeApp } from "./FakeApp";
import {
  appUrl,
  formatAgo,
  hasUnpublishedChanges,
  ideas,
  latestAgentMessage,
  type AgentMessage,
  type Change,
  type Plan,
  type Sim,
  type SimState,
  type Step,
  type YourMessage,
} from "./simulation";
import "./VariantD.css";

export function VariantD({ sim }: { sim: Sim }) {
  const { state } = sim;
  if (state.phase === "start") return <Start onStart={(text) => sim.start(text, { planFirst: true })} />;
  if (state.phase === "planning" || state.phase === "planned") return <PlanView sim={sim} />;
  return <Built sim={sim} />;
}

function Start({ onStart }: { onStart(text: string): void }) {
  return (
    <div className="vd vd-page">
      <div className="vd-sheet">
        <p className="vd-eyebrow">Jigworks · New app</p>
        <h1 className="vd-title">Tell me about the app you want</h1>
        <p className="vd-lede">
          Say who it's for and what they should be able to do. I'll write a plan in plain English first, so you can check
          it before I build anything.
        </p>
        <Composer big placeholder="For example: a sign-up sheet for my running club's Sunday runs" sendLabel="Plan it" onSend={onStart} />
        <section className="vd-examples">
          <h2 className="vd-label">Or start from an example</h2>
          <ul>
            {ideas.map((idea) => (
              <li key={idea}>
                <button type="button" className="vd-example" onClick={() => onStart(idea)}>
                  “{idea}”
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function PlanView({ sim }: { sim: Sim }) {
  const { state } = sim;
  const composer = useRef<HTMLTextAreaElement>(null);
  const planning = state.phase === "planning";
  const latest = latestAgentMessage(state);
  const asked = state.messages.filter((message): message is YourMessage => message.from === "you");

  return (
    <div className="vd vd-page">
      <div className="vd-sheet">
        <p className="vd-eyebrow">You asked for</p>
        {asked.map((message) => (
          <p key={message.id} className="vd-request">
            “{message.text}”
          </p>
        ))}
        <p className="vd-agent-says">{latest?.text || "…"}</p>

        <PlanCard plan={planning ? null : state.plan} onToggle={(index) => sim.togglePlanItem(index)} />

        <div className="vd-row vd-plan-actions">
          <button type="button" className="vd-button vd-button-primary" disabled={planning || !state.plan} onClick={() => sim.approvePlan()}>
            Build it
          </button>
          <button type="button" className="vd-button" disabled={planning} onClick={() => composer.current?.focus()}>
            Change something
          </button>
        </div>
        <Composer
          inputRef={composer}
          disabled={planning}
          placeholder="What should I change in the plan?"
          sendLabel="Update the plan"
          onSend={(text) => sim.send(text)}
        />
      </div>
    </div>
  );
}

/** The plan as a document the person can tick through. Null shows placeholders while the Agent writes it. */
function PlanCard({ plan, onToggle }: { plan: Plan | null; onToggle(index: number): void }) {
  if (!plan) {
    return (
      <article className="vd-plan-card" aria-busy="true" aria-label="Writing the plan">
        {[60, 85, 70, 90, 75].map((width, index) => (
          <div key={index} className="vd-plan-row">
            <span className="vd-shimmer vd-shimmer-label" />
            <span className="vd-shimmer" style={{ width: `${width}%` }} />
          </div>
        ))}
      </article>
    );
  }
  return (
    <article className="vd-plan-card">
      <h2 className="vd-plan-heading">The plan</h2>
      <dl className="vd-plan">
        <div className="vd-plan-row">
          <dt>Name</dt>
          <dd>
            <input className="vd-name-input" defaultValue={plan.name} aria-label="Name" />
          </dd>
        </div>
        <div className="vd-plan-row">
          <dt>Who it's for</dt>
          <dd>{plan.who}</dd>
        </div>
        <div className="vd-plan-row">
          <dt>People can</dt>
          <dd>
            <ul className="vd-checklist">
              {plan.can.map((item, index) => (
                <li key={item.text}>
                  <label>
                    <input type="checkbox" checked={item.on} onChange={() => onToggle(index)} />
                    <span className={item.on ? undefined : "vd-off"}>{item.text}</span>
                  </label>
                </li>
              ))}
              <li>
                <button type="button" className="vd-link">
                  + Add something
                </button>
              </li>
            </ul>
          </dd>
        </div>
        <div className="vd-plan-row">
          <dt>It remembers</dt>
          <dd>{plan.remembers}</dd>
        </div>
        <div className="vd-plan-row">
          <dt>How I'll build it</dt>
          <dd>
            {plan.startingPoint.plain} <span className="vd-small">(the {plan.startingPoint.template} Template)</span>
            <details className="vd-why">
              <summary>Why?</summary>
              <p>{plan.startingPoint.why}</p>
            </details>
          </dd>
        </div>
      </dl>
    </article>
  );
}

function Built({ sim }: { sim: Sim }) {
  const { state } = sim;
  const [showCode, setShowCode] = useState(false);
  // On a phone the brief folds away to its name and status, so the app gets the screen.
  const [briefOpen, setBriefOpen] = useState(false);
  const working = state.phase === "working";
  const latest = latestAgentMessage(state);
  const can = state.plan?.can.filter((item) => item.on) ?? [];

  return (
    <div className="vd vd-built">
      <aside className={`vd-brief${briefOpen ? "" : " vd-brief-folded"}`}>
        <p className="vd-eyebrow">Your app</p>
        <h1 className="vd-app-name">{state.appName ?? state.plan?.name ?? "New app"}</h1>
        {state.plan && <p className="vd-summary">{state.plan.summary}</p>}

        <PublishStatus sim={sim} />
        <button type="button" className="vd-brief-toggle" aria-expanded={briefOpen} onClick={() => setBriefOpen((open) => !open)}>
          {briefOpen ? "Hide the details ▴" : "What it does, and changes ▾"}
        </button>

        {state.plan && (
          <section className="vd-brief-section">
            <h2 className="vd-label">People can</h2>
            <ul className="vd-can">
              {can.map((item) => (
                <li key={item.text}>
                  <span aria-hidden="true">✓</span> {item.text}
                  {item.added && <span className="vd-badge">New</span>}
                </li>
              ))}
            </ul>
            <p className="vd-small">Built from: {state.plan.startingPoint.plain}</p>
          </section>
        )}

        <Timeline state={state} />

        <button type="button" className="vd-link vd-code-link" onClick={() => setShowCode(true)}>
          See the code
        </button>
      </aside>

      <section className="vd-main">
        <div className="vd-app-bar">
          <span>{state.app ? `Version ${state.version} · only you can see this until you publish it` : "Not built yet"}</span>
          {working && state.app && <span className="vd-updating">Updating…</span>}
          <button type="button" className="vd-button vd-button-small" disabled={!state.app}>
            Open in a new tab
          </button>
        </div>
        <div className="vd-app-area">
          {state.app ? (
            <FakeApp features={state.app} />
          ) : working ? (
            <FirstBuildProgress state={state} message={latest} />
          ) : (
            <p className="vd-not-built">Your app isn't built yet. The Agent's note below says why.</p>
          )}
        </div>
        <div className="vd-dock">
          <ReplyCard state={state} message={latest} onAnswer={(text) => sim.send(text)} />
          <Composer disabled={working} placeholder="Ask for a change…" sendLabel="Send" onSend={(text) => sim.send(text)} />
        </div>
        {showCode && (
          <div className="vd-code-over">
            <CodePeek onClose={() => setShowCode(false)} />
          </div>
        )}
      </section>
    </div>
  );
}

function PublishStatus({ sim }: { sim: Sim }) {
  const { state } = sim;
  const [confirming, setConfirming] = useState(false);
  const unpublished = hasUnpublishedChanges(state);

  let status;
  let action: string | null = null;
  if (!state.published) {
    status = (
      <>
        <strong>Not published.</strong> Only you can see it.
      </>
    );
    action = "Publish";
  } else if (unpublished) {
    status = (
      <>
        <strong>Live, with changes not published yet.</strong> People using {appUrl} have version {state.published.version};
        you're on version {state.version}.
      </>
    );
    action = "Publish changes";
  } else {
    status = (
      <>
        <span className="vd-live-dot" aria-hidden="true">
          ●
        </span>{" "}
        Live at <span className="vd-url">{appUrl}</span>
      </>
    );
  }

  return (
    <section className={`vd-status${state.published && !unpublished ? " vd-status-live" : ""}`}>
      <p>{status}</p>
      {confirming ? (
        <div className="vd-confirm">
          <p>
            {state.published
              ? `Everyone using the link gets version ${state.version}.`
              : "Anyone with the link will be able to use it. You can keep changing it here."}
          </p>
          <div className="vd-row">
            <button
              type="button"
              className="vd-button vd-button-primary vd-button-small"
              onClick={() => {
                sim.publish();
                setConfirming(false);
              }}
            >
              {action}
            </button>
            <button type="button" className="vd-button vd-button-small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : action ? (
        <button type="button" className="vd-button vd-button-primary vd-button-small" disabled={!state.app} onClick={() => setConfirming(true)}>
          {action}
        </button>
      ) : (
        <button type="button" className="vd-button vd-button-small">
          Copy the link
        </button>
      )}
    </section>
  );
}

function Timeline({ state }: { state: SimState }) {
  const [open, setOpen] = useState<string | null>(null);
  const working = state.phase === "working";
  const changes = [...state.changes].reverse();

  return (
    <section className="vd-brief-section">
      <h2 className="vd-label">Changes</h2>
      <ol className="vd-timeline">
        {working && (
          <li className="vd-change vd-change-running">
            <div className="vd-change-head">
              <span className="vd-dot" aria-hidden="true" />
              <span className="vd-change-text">{state.activity ?? "Working…"}</span>
              <span className="vd-small">now</span>
            </div>
          </li>
        )}
        {changes.length === 0 && !working && <li className="vd-small">Nothing yet.</li>}
        {changes.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            state={state}
            open={open === change.id}
            onToggle={() => setOpen((current) => (current === change.id ? null : change.id))}
          />
        ))}
      </ol>
    </section>
  );
}

/** One change, which opens to show the exchange that made it. */
function ChangeRow({ change, state, open, onToggle }: { change: Change; state: SimState; open: boolean; onToggle(): void }) {
  const index = state.messages.findIndex((message) => message.id === change.id);
  const found = state.messages[index];
  const agent = found?.from === "agent" ? (found as AgentMessage) : undefined;
  let asked: YourMessage | undefined;
  for (let i = index - 1; i >= 0; i--) {
    const message = state.messages[i]!;
    if (message.from === "you") {
      asked = message;
      break;
    }
  }

  return (
    <li className={`vd-change${change.failed ? " vd-change-failed" : ""}`}>
      <button type="button" className="vd-change-head" aria-expanded={open} onClick={onToggle}>
        <span className="vd-dot" aria-hidden="true" />
        <span className="vd-change-text">{change.text}</span>
        <span className="vd-small">
          {formatAgo(change.at)}
          {!change.failed && ` · v${change.version}`}
        </span>
      </button>
      {open && agent && (
        <div className="vd-exchange">
          {asked && (
            <p>
              <span className="vd-small">You asked</span>
              <br />“{asked.text}”
            </p>
          )}
          {agent.text.split("\n\n").map((paragraph, i) => (paragraph ? <p key={i}>{paragraph}</p> : null))}
          <StepList steps={agent.steps} technical />
        </div>
      )}
    </li>
  );
}

function StepList({ steps, technical = false }: { steps: Step[]; technical?: boolean }) {
  return (
    <ul className="vd-steps">
      {steps.map((step, index) => (
        <li key={index} className={`vd-step vd-step-${step.status}`}>
          <span className="vd-step-icon" aria-hidden="true">
            {step.status === "done" ? "✓" : step.status === "failed" ? "✕" : step.status === "fixing" ? "↻" : "◌"}
          </span>
          <span>
            {step.label}
            {step.result && <span className="vd-small"> · {step.result}</span>}
            {technical && <span className="vd-tech">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** While the first Build runs, the plan's items tick off beside the Agent's steps. */
function FirstBuildProgress({ state, message }: { state: SimState; message: AgentMessage | undefined }) {
  const items = state.plan?.can.filter((item) => item.on) ?? [];
  const progress = state.progress;
  const share = progress ? progress.done / progress.total : 0;
  const ticked = Math.floor(share * items.length);

  return (
    <div className="vd-progress">
      <h2 className="vd-progress-title">Building {state.appName ?? "your app"}</h2>
      <p className="vd-small">{state.activity ?? "Getting started…"}</p>
      <div className="vd-progress-bar">
        <span style={{ width: `${Math.max(4, share * 100)}%` }} />
      </div>
      <div className="vd-progress-columns">
        <section>
          <h3 className="vd-label">From the plan</h3>
          <ul className="vd-plan-ticks">
            {items.map((item, index) => (
              <li key={item.text} className={index < ticked ? "vd-ticked" : undefined}>
                <span aria-hidden="true">{index < ticked ? "✓" : "○"}</span> {item.text}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="vd-label">What I'm doing</h3>
          {message && <StepList steps={message.steps} />}
        </section>
      </div>
    </div>
  );
}

/** The Agent's latest word, short: what it's doing now, or how the last Turn went. */
function ReplyCard({
  state,
  message,
  onAnswer,
}: {
  state: SimState;
  message: AgentMessage | undefined;
  onAnswer(text: string): void;
}) {
  if (state.phase === "working") {
    const progress = state.progress;
    return (
      <div className="vd-reply vd-reply-working" role="status">
        <span className="vd-spinner" aria-hidden="true" />
        <span>{state.activity ?? "Working…"}</span>
        {progress && (
          <span className="vd-small">
            step {Math.min(progress.done + 1, progress.total)} of {progress.total}
          </span>
        )}
      </div>
    );
  }
  if (!message) return null;
  const paragraphs = message.text.split("\n\n").filter(Boolean);
  return (
    <div className={`vd-reply${message.failed ? " vd-reply-failed" : ""}`}>
      <p>{paragraphs[paragraphs.length - 1]}</p>
      {message.choices && state.pendingQuestion && (
        <div className="vd-row">
          {message.choices.map((choice) => (
            <button key={choice} type="button" className="vd-button vd-button-small" onClick={() => onAnswer(choice)}>
              {choice}
            </button>
          ))}
        </div>
      )}
      {state.suggestions.length > 0 && (
        <div className="vd-chips">
          {state.suggestions.map((suggestion) => (
            <button key={suggestion} type="button" className="vd-chip" onClick={() => onAnswer(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  inputRef,
  big = false,
  disabled = false,
  placeholder,
  sendLabel,
  onSend,
}: {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
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
    <form className={`vd-composer${big ? " vd-composer-big" : ""}`} onSubmit={send}>
      <textarea
        ref={inputRef}
        aria-label="Message to the Agent"
        rows={big ? 4 : 1}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="vd-button vd-button-primary" disabled={disabled || !text.trim()}>
        {sendLabel}
      </button>
    </form>
  );
}
