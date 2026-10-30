// PROTOTYPE, throwaway. Variant B, "Chat beside the app": the chat on the left, the app on the right, from the first second.
// The Agent speaks first; the right-hand canvas fills in as it builds, then stays live while you ask for changes.
// The Template shows as a "Started from" chip on the Agent's first message, with a "Why?".
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
import "./VariantB.css";

type Device = "phone" | "computer";
type Tab = "chat" | "app";

export function VariantB({ sim }: { sim: Sim }) {
  const { state } = sim;
  const [device, setDevice] = useState<Device>("computer");
  const [showCode, setShowCode] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const seenVersion = useRef(state.version);

  // On a narrow screen, show the app when a Turn finishes building.
  useEffect(() => {
    if (state.version > seenVersion.current) setTab("app");
    seenVersion.current = state.version;
  }, [state.version]);

  const unpublished = hasUnpublishedChanges(state);
  let publishLabel = "Publish";
  if (state.published) publishLabel = unpublished ? "Publish changes" : "Share";

  return (
    <div className="vb">
      <header className="vb-header">
        <span className="vb-logo">Jigworks</span>
        <span className="vb-divider" aria-hidden="true">
          /
        </span>
        <span className="vb-name">{state.appName ?? "New app"}</span>
        <StatusPill state={state} />
        <div className="vb-publish-wrap">
          <button
            type="button"
            className="vb-button vb-button-primary"
            disabled={!state.app}
            onClick={() => setPublishing((open) => !open)}
          >
            {publishLabel}
          </button>
          {publishing && <PublishPopover sim={sim} onClose={() => setPublishing(false)} />}
        </div>
      </header>

      <div className="vb-tabs" role="tablist" aria-label="Chat and app">
        {(["chat", "app"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className="vb-tab"
            onClick={() => setTab(key)}
          >
            {key === "chat" ? "Chat" : "App"}
          </button>
        ))}
      </div>

      <div className="vb-body" data-tab={tab}>
        <ChatPane sim={sim} />
        <section className="vb-canvas" aria-label="Your app">
          <Canvas
            sim={sim}
            device={device}
            onDevice={setDevice}
            showCode={showCode}
            onToggleCode={() => setShowCode((shown) => !shown)}
          />
        </section>
      </div>
    </div>
  );
}

function StatusPill({ state }: { state: SimState }) {
  if (!state.published) return <span className="vb-status">Not published</span>;
  if (hasUnpublishedChanges(state))
    return (
      <span className="vb-status vb-status-changed">
        <span aria-hidden="true">● </span>Live · changes not published
      </span>
    );
  return (
    <span className="vb-status vb-status-live">
      <span aria-hidden="true">● </span>Live
    </span>
  );
}

function PublishPopover({ sim, onClose }: { sim: Sim; onClose(): void }) {
  const { state } = sim;
  const unpublished = hasUnpublishedChanges(state);
  return (
    <>
      <div className="vb-popover-backdrop" onClick={onClose} />
      <div className="vb-popover" role="dialog" aria-label="Publish">
        {!state.published && (
          <>
            <p className="vb-popover-title">Put {state.appName} online?</p>
            <p>Anyone with this link will be able to use it:</p>
            <p className="vb-url">{appUrl}</p>
            <p className="vb-quiet">You can keep changing it here. People see your changes only when you publish again.</p>
            <div className="vb-popover-actions">
              <button type="button" className="vb-button" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="vb-button vb-button-primary" onClick={sim.publish}>
                Publish
              </button>
            </div>
          </>
        )}
        {state.published && unpublished && (
          <>
            <p className="vb-popover-title">Publish your changes?</p>
            <p>
              People using the link see version {state.published.version}. Publishing gives them version {state.version}.
            </p>
            <p className="vb-url">{appUrl}</p>
            <div className="vb-popover-actions">
              <button type="button" className="vb-button" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="vb-button vb-button-primary" onClick={sim.publish}>
                Publish changes
              </button>
            </div>
          </>
        )}
        {state.published && !unpublished && (
          <>
            <p className="vb-popover-title">{state.appName} is live</p>
            <p className="vb-url">{appUrl}</p>
            <div className="vb-popover-actions">
              <button type="button" className="vb-button">
                Copy the link
              </button>
              <button type="button" className="vb-button vb-button-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ChatPane({ sim }: { sim: Sim }) {
  const { state } = sim;
  const scroller = useRef<HTMLDivElement>(null);
  const working = state.phase === "working" || state.phase === "planning";
  const latest = latestAgentMessage(state);
  const firstAgentId = state.messages.find((message) => message.from === "agent")?.id;

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.suggestions]);

  function send(text: string) {
    if (state.phase === "start") sim.start(text);
    else sim.send(text);
  }

  let placeholder = "Ask for a change…";
  if (state.phase === "start") placeholder = "Describe your app…";
  else if (working) placeholder = "The Agent is working…";

  return (
    <section className="vb-chat" aria-label="Conversation">
      <div ref={scroller} className="vb-chat-scroll">
        <ol className="vb-messages">
          <li className="vb-bubble vb-bubble-agent">
            <p>Hi! What would you like to make? A sign-up sheet, a booking page, a little tracker… just describe it.</p>
          </li>
          {state.phase === "start" && (
            <li className="vb-ideas">
              {ideas.map((idea) => (
                <button key={idea} type="button" className="vb-idea" onClick={() => sim.start(idea)}>
                  {idea}
                </button>
              ))}
            </li>
          )}
          {state.messages.map((message) =>
            message.from === "you" ? (
              <li key={message.id} className="vb-bubble vb-bubble-you">
                {message.pointedAt && <span className="vb-about">About {message.pointedAt}</span>}
                {message.text}
              </li>
            ) : (
              <AgentBubble
                key={message.id}
                message={message}
                sim={sim}
                isFirst={message.id === firstAgentId}
                isLatest={message.id === latest?.id}
              />
            ),
          )}
        </ol>
      </div>
      <div className="vb-chat-bottom">
        {state.suggestions.length > 0 && (
          <div className="vb-suggestions">
            {state.suggestions.map((suggestion) => (
              <button key={suggestion} type="button" className="vb-chip" onClick={() => sim.send(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <Composer disabled={working} placeholder={placeholder} onSend={send} />
      </div>
    </section>
  );
}

const stepIcon = (step: Step) =>
  step.status === "done" ? "✓" : step.status === "failed" ? "!" : step.status === "fixing" ? "↻" : "◌";

function AgentBubble({
  message,
  sim,
  isFirst,
  isLatest,
}: {
  message: AgentMessage;
  sim: Sim;
  isFirst: boolean;
  isLatest: boolean;
}) {
  const { state } = sim;
  const [technical, setTechnical] = useState(false);
  const startingPoint = state.plan?.startingPoint;
  const choseStart = message.steps.some((step) => step.label === "Choosing a starting point" && step.status === "done");

  return (
    <li className={`vb-bubble vb-bubble-agent${message.failed ? " vb-bubble-failed" : ""}`}>
      {message.failed && <p className="vb-failed-label">Didn't work this time · your app hasn't changed</p>}
      {message.text.split("\n\n").map((paragraph, index) => (paragraph ? <p key={index}>{paragraph}</p> : null))}

      {isFirst && choseStart && startingPoint && (
        <div className="vb-start-chip">
          <span>
            Started from: <strong>{startingPoint.plain}</strong> · {startingPoint.template}
          </span>
          <details>
            <summary>Why?</summary>
            <p>{startingPoint.why}</p>
          </details>
        </div>
      )}

      {message.steps.length > 0 && (
        <>
          <ul className="vb-steps">
            {message.steps.map((step, index) => (
              <li key={index} className={`vb-step vb-step-${step.status}`}>
                <span className="vb-step-icon" aria-hidden="true">
                  {stepIcon(step)}
                </span>
                <span>
                  {step.label}
                  {step.result && <span className="vb-step-result"> · {step.result}</span>}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="vb-link" aria-expanded={technical} onClick={() => setTechnical((shown) => !shown)}>
            {technical ? "Hide technical details" : "Technical details"}
          </button>
          {technical && (
            <ul className="vb-technical">
              {message.steps.map((step, index) => (
                <li key={index}>{step.detail}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {message.choices && isLatest && state.pendingQuestion && (
        <div className="vb-choices">
          {message.choices.map((choice) => (
            <button key={choice} type="button" className="vb-button" onClick={() => sim.send(choice)}>
              {choice}
            </button>
          ))}
        </div>
      )}

      {message.isPlan && state.phase === "planned" && isLatest && (
        <div className="vb-choices">
          <button type="button" className="vb-button vb-button-primary" onClick={sim.approvePlan}>
            Build it
          </button>
        </div>
      )}
    </li>
  );
}

function Composer({
  disabled,
  placeholder,
  onSend,
}: {
  disabled: boolean;
  placeholder: string;
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
    <form className="vb-composer" onSubmit={send}>
      <textarea
        aria-label="Message to the Agent"
        rows={2}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="vb-button vb-button-primary" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}

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

  if (!state.app) {
    if (working) return <Building state={state} />;
    const firstFailed = latestAgentMessage(state)?.failed;
    return (
      <div className="vb-empty">
        <div className="vb-skeleton" aria-hidden="true">
          <span className="vb-skeleton-line vb-skeleton-short" />
          <span className="vb-skeleton-line vb-skeleton-title" />
          <span className="vb-skeleton-box" />
          <span className="vb-skeleton-box vb-skeleton-tall" />
        </div>
        <p className="vb-empty-text">
          {firstFailed ? "Nothing to show yet. Ask the Agent to try again." : "Your app will appear here"}
        </p>
      </div>
    );
  }

  return (
    <div className="vb-canvas-inner">
      <div className="vb-toolbar">
        <div className="vb-segmented" role="group" aria-label="Show it on">
          {(["phone", "computer"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={device === option && !showCode}
              onClick={() => {
                onDevice(option);
                if (showCode) onToggleCode();
              }}
            >
              {option === "phone" ? "Phone" : "Computer"}
            </button>
          ))}
        </div>
        <button type="button" className="vb-button vb-button-small">
          Open in a new tab ↗
        </button>
        <span className="vb-toolbar-space" />
        <button type="button" className="vb-quiet-toggle" aria-pressed={showCode} onClick={onToggleCode}>
          {"</>"} Code
        </button>
      </div>

      {working && !showCode && (
        <div className="vb-banner" role="status">
          <span>Updating: {state.activity ?? "…"}</span>
          {state.progress && (
            <span className="vb-progress vb-progress-small">
              <span style={{ width: `${(state.progress.done / state.progress.total) * 100}%` }} />
            </span>
          )}
        </div>
      )}

      {showCode ? (
        <div className="vb-code">
          <CodePeek onClose={onToggleCode} />
        </div>
      ) : (
        <div className={`vb-stage vb-stage-${device}${working ? " vb-dimmed" : ""}`}>
          {device === "phone" ? (
            <div className="vb-phone">
              <FakeApp features={state.app} />
            </div>
          ) : (
            <div className="vb-browser">
              <div className="vb-browser-bar">
                <span className="vb-dots" aria-hidden="true">
                  ● ● ●
                </span>
                <span className="vb-browser-url">
                  {state.published ? appUrl : "Only you can see this until you publish"}
                </span>
              </div>
              <div className="vb-browser-page">
                <FakeApp features={state.app} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Building({ state }: { state: SimState }) {
  const steps = latestAgentMessage(state)?.steps.filter((step) => step.status === "done") ?? [];
  const progress = state.progress;
  return (
    <div className="vb-building">
      <p className="vb-building-kicker">Building your app</p>
      <p className="vb-building-activity" role="status">
        {state.activity ?? "Getting started…"}
      </p>
      <span className="vb-progress">
        <span style={{ width: progress ? `${Math.max(4, (progress.done / progress.total) * 100)}%` : "4%" }} />
      </span>
      <ul className="vb-building-steps">
        {steps.map((step, index) => (
          <li key={index}>
            <span className="vb-step-icon" aria-hidden="true">
              ✓
            </span>
            {step.label === "Choosing a starting point" ? (
              <span>
                Starting point: <strong>{step.result}</strong>
              </span>
            ) : step.label === "Naming your app" ? (
              <span>
                Name: <strong>{step.result}</strong>
              </span>
            ) : (
              <span>{step.label}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
