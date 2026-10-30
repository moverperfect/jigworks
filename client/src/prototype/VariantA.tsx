// PROTOTYPE, throwaway. Variant A, "Just a conversation": one centred column, like a chat app.
// The app arrives inside the Conversation as a live card; full screen is one click away.
// The Agent's work collapses to a one-line summary; the Template shows only as a step it took.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { CodePeek } from "./CodePeek";
import { FakeApp } from "./FakeApp";
import { appUrl, hasUnpublishedChanges, ideas, type AgentMessage, type Sim, type Step } from "./simulation";
import "./VariantA.css";

export function VariantA({ sim }: { sim: Sim }) {
  const { state } = sim;
  const [fullScreen, setFullScreen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages]);

  if (state.phase === "start") return <Start onStart={(text) => sim.start(text)} />;

  const working = state.phase === "working";
  const unpublished = hasUnpublishedChanges(state);
  let shareLabel = "Publish";
  if (state.published) shareLabel = unpublished ? "Publish changes" : "Live";

  return (
    <div className="va">
      <header className="va-top">
        <span className="va-logo">Jigworks</span>
        <span className="va-name">{state.appName ?? "New app"}</span>
        <div className="va-top-actions">
          {state.app && (
            <button type="button" className={`va-pill${unpublished ? " va-pill-dot" : ""}`} onClick={() => setSharing(true)}>
              {state.published && !unpublished && <span aria-hidden="true">● </span>}
              {shareLabel}
            </button>
          )}
          <div className="va-menu-wrap">
            <button type="button" className="va-icon" aria-label="More" onClick={() => setMenuOpen((open) => !open)}>
              ⋯
            </button>
            {menuOpen && (
              <ul className="va-menu" onClick={() => setMenuOpen(false)}>
                <li>
                  <button type="button">My apps</button>
                </li>
                <li>
                  <button type="button" onClick={() => setShowCode(true)}>
                    See the code
                  </button>
                </li>
                <li>
                  <button type="button">Download a copy</button>
                </li>
                <li>
                  <button type="button" className="va-danger">
                    Delete this app
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>
      </header>

      <div ref={scroller} className="va-scroll">
        <ol className="va-messages">
          {state.messages.map((message) =>
            message.from === "you" ? (
              <li key={message.id} className="va-you">
                {message.pointedAt && <span className="va-about">About {message.pointedAt}</span>}
                {message.text}
              </li>
            ) : (
              <AgentItem
                key={message.id}
                message={message}
                latestVersion={state.version}
                working={working}
                onAnswer={(text) => sim.send(text)}
                appCard={
                  message.builtVersion === state.version && state.app ? (
                    <div className="va-card">
                      <div className="va-card-app">
                        <FakeApp features={state.app} />
                      </div>
                      <div className="va-card-actions">
                        <span className="va-card-label">
                          {state.appName} · version {state.version}
                        </span>
                        <button type="button" className="va-button" onClick={() => setFullScreen(true)}>
                          Open full screen
                        </button>
                        <button type="button" className="va-button va-button-primary" onClick={() => setSharing(true)}>
                          {state.published && !unpublished ? "Share the link" : "Publish"}
                        </button>
                      </div>
                    </div>
                  ) : null
                }
              />
            ),
          )}
        </ol>
      </div>

      <div className="va-bottom">
        {state.suggestions.length > 0 && (
          <div className="va-suggestions">
            {state.suggestions.map((suggestion) => (
              <button key={suggestion} type="button" className="va-chip" onClick={() => sim.send(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <Composer
          disabled={working || state.phase === "planning"}
          placeholder={working ? `The Agent is working: ${state.activity ?? "…"}` : "Ask for a change…"}
          onSend={(text) => sim.send(text)}
        />
      </div>

      {fullScreen && state.app && (
        <div className="va-overlay">
          <div className="va-overlay-bar">
            <button type="button" className="va-button" onClick={() => setFullScreen(false)}>
              ← Back to the conversation
            </button>
            <span className="va-overlay-url">{state.published ? appUrl : "Only you can see this until you publish"}</span>
            <button type="button" className="va-button va-button-primary" onClick={() => setSharing(true)}>
              {shareLabel}
            </button>
          </div>
          <div className="va-overlay-app">
            <FakeApp features={state.app} />
          </div>
        </div>
      )}

      {sharing && <ShareDialog sim={sim} onClose={() => setSharing(false)} />}

      {showCode && (
        <div className="va-overlay">
          <CodePeek onClose={() => setShowCode(false)} />
        </div>
      )}
    </div>
  );
}

function Start({ onStart }: { onStart(text: string): void }) {
  return (
    <div className="va va-start">
      <header className="va-top">
        <span className="va-logo">Jigworks</span>
      </header>
      <div className="va-start-body">
        <h1 className="va-hero">What would you like to make?</h1>
        <p className="va-lede">Describe it in your own words. I'll build it, and you can change anything just by asking.</p>
        <Composer big placeholder="For example: a sign-up sheet for my running club" onSend={onStart} />
        <div className="va-ideas">
          <span className="muted">Ideas:</span>
          {ideas.map((idea) => (
            <button key={idea} type="button" className="va-chip" onClick={() => onStart(idea)}>
              {idea}
            </button>
          ))}
        </div>
        <section className="va-recent">
          <h2 className="va-recent-heading">Your apps</h2>
          <ul>
            <li>
              <span>Bake sale orders</span>
              <span className="va-live">● Live</span>
              <span className="muted">changed yesterday</span>
            </li>
            <li>
              <span>Allotment rota</span>
              <span className="muted">Not published</span>
              <span className="muted">changed 3 weeks ago</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function Composer({
  big = false,
  disabled = false,
  placeholder,
  onSend,
}: {
  big?: boolean;
  disabled?: boolean;
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
    <form className={`va-composer${big ? " va-composer-big" : ""}`} onSubmit={send}>
      <textarea
        aria-label="Message to the Agent"
        rows={big ? 3 : 1}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="va-send" disabled={disabled || !text.trim()} aria-label="Send">
        ↑
      </button>
    </form>
  );
}

function AgentItem({
  message,
  latestVersion,
  working,
  onAnswer,
  appCard,
}: {
  message: AgentMessage;
  latestVersion: number;
  working: boolean;
  onAnswer(text: string): void;
  appCard: ReactNode;
}) {
  const finished = message.builtVersion !== undefined || message.failed || message.choices !== undefined || !working;
  return (
    <li className="va-agent">
      {message.text.split("\n\n").map((paragraph, index) => (paragraph ? <p key={index}>{paragraph}</p> : null))}
      {message.steps.length > 0 && <StepSummary steps={message.steps} finished={finished} failed={message.failed ?? false} />}
      {message.choices && (
        <div className="va-choices">
          {message.choices.map((choice) => (
            <button key={choice} type="button" className="va-button" onClick={() => onAnswer(choice)}>
              {choice}
            </button>
          ))}
        </div>
      )}
      {appCard}
      {message.builtVersion !== undefined && message.builtVersion < latestVersion && (
        <p className="va-old-version">Version {message.builtVersion} · replaced by a newer version</p>
      )}
    </li>
  );
}

/** While the Agent works, every step shows; afterwards, one line that opens to show them. */
function StepSummary({ steps, finished, failed }: { steps: Step[]; finished: boolean; failed: boolean }) {
  const list = (
    <ul className="va-steps">
      {steps.map((step, index) => (
        <li key={index} className={`va-step va-step-${step.status}`}>
          <span className="va-step-icon" aria-hidden="true">
            {step.status === "done" ? "✓" : step.status === "failed" ? "✕" : step.status === "fixing" ? "↻" : "◌"}
          </span>
          <span>
            {step.label}
            {step.result && <span className="va-step-result"> · {step.result}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
  if (!finished) return list;
  return (
    <details className="va-steps-summary" open={failed}>
      <summary>{failed ? `⚠ Stopped after ${steps.length} steps` : `✓ Done in ${steps.length} steps`}</summary>
      {list}
      <details className="va-technical">
        <summary>Technical details</summary>
        <ul>
          {steps.map((step, index) => (
            <li key={index}>{step.detail}</li>
          ))}
        </ul>
      </details>
    </details>
  );
}

function ShareDialog({ sim, onClose }: { sim: Sim; onClose(): void }) {
  const { state } = sim;
  const unpublished = hasUnpublishedChanges(state);
  return (
    <div className="va-dialog-backdrop" onClick={onClose}>
      <div className="va-dialog" role="dialog" aria-label="Publish" onClick={(event) => event.stopPropagation()}>
        {!state.published && (
          <>
            <h2>Publish {state.appName}?</h2>
            <p>
              Anyone with the link will be able to use it: <strong>{appUrl}</strong>
            </p>
            <p className="muted">You can keep changing it here. People only see your changes when you publish again.</p>
            <div className="va-dialog-actions">
              <button type="button" className="va-button" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="va-button va-button-primary" onClick={sim.publish}>
                Publish
              </button>
            </div>
          </>
        )}
        {state.published && unpublished && (
          <>
            <h2>Publish your changes?</h2>
            <p>
              People using <strong>{appUrl}</strong> have version {state.published.version}. Publishing gives them version{" "}
              {state.version}.
            </p>
            <div className="va-dialog-actions">
              <button type="button" className="va-button" onClick={onClose}>
                Not yet
              </button>
              <button type="button" className="va-button va-button-primary" onClick={sim.publish}>
                Publish changes
              </button>
            </div>
          </>
        )}
        {state.published && !unpublished && (
          <>
            <h2>{state.appName} is live</h2>
            <p className="va-link">{appUrl}</p>
            <div className="va-dialog-actions">
              <button type="button" className="va-button">
                Copy the link
              </button>
              <button type="button" className="va-button">
                Send on WhatsApp
              </button>
              <button type="button" className="va-button va-button-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
