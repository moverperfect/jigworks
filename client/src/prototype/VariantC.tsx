// PROTOTYPE, throwaway. Variant C, "The app is the canvas": app first, ask anywhere.
// A short interview starts it; once built, the app fills the screen and the Conversation floats over it.
// Point at any part of the app to talk about it. The Template appears only under "About this app".
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CodePeek } from "./CodePeek";
import { FakeApp, type Pointed } from "./FakeApp";
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
import "./VariantC.css";

export function VariantC({ sim }: { sim: Sim }) {
  const { state } = sim;
  if (state.phase === "start") return <Interview onStart={(text) => sim.start(text)} />;
  if (!state.app) return <Building sim={sim} />;
  return <Canvas sim={sim} />;
}

const audiences = ["Just me", "People I send the link to", "Anyone on the internet"];
const abilities = ["Put their name down", "See a list", "Book a time", "Pay", "Email me"];

/** One question at a time, then one request built from the answers. */
function Interview({ onStart }: { onStart(text: string): void }) {
  const [question, setQuestion] = useState(0);
  const [purpose, setPurpose] = useState("");
  const [audience, setAudience] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [extra, setExtra] = useState("");

  function make(withAbilities: boolean) {
    const parts = [purpose.trim().replace(/\.$/, "") + "."];
    if (audience) parts.push(`It's for ${audience.toLowerCase()}.`);
    if (withAbilities && chosen.length > 0) parts.push(`People should be able to: ${chosen.join(", ").toLowerCase()}.`);
    if (withAbilities && extra.trim()) parts.push(extra.trim());
    onStart(parts.join(" "));
  }

  function toggle(ability: string) {
    setChosen((list) => (list.includes(ability) ? list.filter((a) => a !== ability) : [...list, ability]));
  }

  return (
    <div className="vc vc-interview">
      <header className="vc-interview-top">
        <span className="vc-logo">Jigworks</span>
        <span className="muted">Let's make you an app</span>
      </header>
      <div className="vc-interview-body">
        <ol className="vc-dots" aria-label={`Question ${question + 1} of 3`}>
          {[0, 1, 2].map((index) => (
            <li key={index} className={index === question ? "vc-dot vc-dot-current" : index < question ? "vc-dot vc-dot-done" : "vc-dot"} />
          ))}
        </ol>

        {question === 0 && (
          <form
            className="vc-question"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (purpose.trim()) setQuestion(1);
            }}
          >
            <h1 className="vc-question-title">What's it for?</h1>
            <p className="vc-question-hint">A sentence is plenty. You can change everything later.</p>
            <textarea
              className="vc-textbox"
              rows={3}
              value={purpose}
              placeholder="For example: a sign-up sheet for my running club"
              onChange={(event) => setPurpose(event.target.value)}
              autoFocus
            />
            <div className="vc-examples">
              <span className="muted">Or try one of these:</span>
              {ideas.map((idea) => (
                <button key={idea} type="button" className="vc-example" onClick={() => setPurpose(idea)}>
                  {idea}
                </button>
              ))}
            </div>
            <div className="vc-question-actions">
              <span />
              <button type="submit" className="vc-next" disabled={!purpose.trim()}>
                Next
              </button>
            </div>
          </form>
        )}

        {question === 1 && (
          <div className="vc-question">
            <h1 className="vc-question-title">Who'll use it?</h1>
            <p className="vc-question-hint">This decides who can open it once it's published.</p>
            <div className="vc-options">
              {audiences.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`vc-option${audience === option ? " vc-option-on" : ""}`}
                  aria-pressed={audience === option}
                  onClick={() => {
                    setAudience(option);
                    setQuestion(2);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="vc-question-actions">
              <button type="button" className="vc-back" onClick={() => setQuestion(0)}>
                ← Back
              </button>
              <span />
            </div>
          </div>
        )}

        {question === 2 && (
          <div className="vc-question">
            <h1 className="vc-question-title">What should people be able to do?</h1>
            <p className="vc-question-hint">Pick any that fit. I'll work out the rest.</p>
            <div className="vc-abilities">
              {abilities.map((ability) => (
                <button
                  key={ability}
                  type="button"
                  className={`vc-ability${chosen.includes(ability) ? " vc-ability-on" : ""}`}
                  aria-pressed={chosen.includes(ability)}
                  onClick={() => toggle(ability)}
                >
                  {chosen.includes(ability) ? "✓ " : "+ "}
                  {ability}
                </button>
              ))}
            </div>
            <label className="vc-extra">
              <span>Anything else? (optional)</span>
              <input className="vc-textbox" value={extra} onChange={(event) => setExtra(event.target.value)} />
            </label>
            <div className="vc-question-actions">
              <button type="button" className="vc-back" onClick={() => setQuestion(1)}>
                ← Back
              </button>
              <div className="vc-question-buttons">
                <button type="button" className="vc-skip" onClick={() => make(false)}>
                  Skip
                </button>
                <button type="button" className="vc-next" onClick={() => make(true)}>
                  Make my app
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const wireframe = ["vc-wire-heading", "vc-wire-details", "vc-wire-form", "vc-wire-list"];

/** Before there's an app: the app assembling, and nothing else. */
function Building({ sim }: { sim: Sim }) {
  const { state } = sim;
  const done = state.progress?.done ?? 0;
  const total = state.progress?.total ?? wireframe.length + 1;
  const latest = latestAgentMessage(state);
  const stopped = state.phase === "ready" || state.phase === "planned";

  return (
    <div className="vc vc-building">
      <div className="vc-wireframe" aria-hidden="true">
        {wireframe.map((block, index) => (
          <div
            key={block}
            className={`vc-wire ${block}${index < done ? " vc-wire-in" : index === done && !stopped ? " vc-wire-next" : ""}`}
          />
        ))}
      </div>
      {!stopped && (
        <div className="vc-building-words" role="status">
          <p className="vc-building-title">{state.appName ? `Making ${state.appName}` : "Making your app"}</p>
          <p className="vc-building-activity">{state.activity ?? "Getting started…"}</p>
          {state.progress && (
            <p className="muted">
              Step {Math.min(done + 1, total)} of {total}
            </p>
          )}
        </div>
      )}
      {state.phase === "ready" && latest && (
        <div className="vc-building-words vc-building-stopped">
          <p>{lastParagraph(latest.text)}</p>
          <div className="vc-chips">
            {state.suggestions.map((suggestion) => (
              <button key={suggestion} type="button" className="vc-chip" onClick={() => sim.send(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
      {state.phase === "planned" && (
        <div className="vc-building-words">
          <p>I've worked out a plan.</p>
          <button type="button" className="vc-next" onClick={sim.approvePlan}>
            Build it
          </button>
        </div>
      )}
    </div>
  );
}

type Popover = "menu" | "about" | "publish" | null;

/** Once there's an app: the app is the page, and everything else floats over it. */
function Canvas({ sim }: { sim: Sim }) {
  const { state } = sim;
  const [pointing, setPointing] = useState(false);
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const [text, setText] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [hintShown, setHintShown] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const working = state.phase === "working" || state.phase === "planning";
  const latest = latestAgentMessage(state);
  const toastShown = working || (latest !== undefined && latest.id !== dismissed);

  useEffect(() => {
    if (!pointing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPointing(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pointing]);

  function point(part: Pointed) {
    setPointed(part);
    setPointing(false);
    input.current?.focus();
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (working || !text.trim()) return;
    sim.send(text.trim(), pointed ?? undefined);
    setText("");
    setPointed(null);
    setHintShown(false);
  }

  return (
    <div className="vc vc-canvas">
      <div className={`vc-app${pointing ? " vc-app-pointing" : ""}`}>
        <FakeApp features={state.app!} pointing={pointing} onPoint={point} />
      </div>
      {working && <div className="vc-shimmer" aria-hidden="true" />}

      <div className="vc-float vc-float-left">
        <div className="vc-name-chip">
          <span className="vc-name">{state.appName}</span>
          <button
            type="button"
            className="vc-icon"
            aria-label="More"
            aria-expanded={popover === "menu"}
            onClick={() => setPopover(popover === "menu" ? null : "menu")}
          >
            ⋯
          </button>
        </div>
        <button type="button" className="vc-float-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
          History
        </button>
        {popover === "menu" && (
          <ul className="vc-popover vc-menu" onClick={(event) => event.stopPropagation()}>
            <li>
              <button type="button" onClick={() => setPopover("about")}>
                About this app
              </button>
            </li>
            <li>
              <button type="button" onClick={() => setPopover(null)}>
                My apps
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setPopover(null);
                  setShowCode(true);
                }}
              >
                See the code
              </button>
            </li>
            <li>
              <button type="button" onClick={() => setPopover(null)}>
                Download a copy
              </button>
            </li>
          </ul>
        )}
        {popover === "about" && <About state={state} onClose={() => setPopover(null)} />}
      </div>

      <div className="vc-float vc-float-right">
        <PublishPill sim={sim} open={popover === "publish"} onToggle={() => setPopover(popover === "publish" ? null : "publish")} />
      </div>

      <div className="vc-bottom">
        {toastShown && (
          <Toast
            state={state}
            latest={latest}
            working={working}
            onDismiss={() => latest && setDismissed(latest.id)}
            onSend={(reply) => {
              sim.send(reply);
              setHintShown(false);
            }}
          />
        )}
        <form className={`vc-composer${pointing ? " vc-composer-pointing" : ""}`} onSubmit={send}>
          <div className="vc-point-wrap">
            <button
              type="button"
              className={`vc-point${pointing ? " vc-point-on" : ""}`}
              aria-pressed={pointing}
              title="Point at part of your app"
              onClick={() => {
                setPointing((on) => !on);
                setHintShown(false);
              }}
              disabled={working}
            >
              <span aria-hidden="true">⌖</span> Point
            </button>
          </div>
          {pointed && (
            <span className="vc-tag">
              About: {pointed.label}
              <button type="button" aria-label="Remove" onClick={() => setPointed(null)}>
                ×
              </button>
            </span>
          )}
          <input
            ref={input}
            className="vc-input"
            aria-label="Message to the Agent"
            value={text}
            placeholder={pointing ? "Click a part of your app… (Esc to cancel)" : pointed ? `What should change about ${pointed.label}?` : hintShown ? "Ask for a change, or press Point and pick part of your app" : "Ask for a change…"}
            disabled={working}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="vc-send" disabled={working || !text.trim()}>
            Send
          </button>
        </form>
      </div>

      {historyOpen && <History state={state} onClose={() => setHistoryOpen(false)} />}

      {showCode && (
        <div className="vc-code">
          <CodePeek onClose={() => setShowCode(false)} />
        </div>
      )}
    </div>
  );
}

function About({ state, onClose }: { state: SimState; onClose(): void }) {
  const startingPoint = state.plan?.startingPoint;
  return (
    <div className="vc-popover vc-about" role="dialog" aria-label="About this app">
      <div className="vc-popover-head">
        <strong>About {state.appName}</strong>
        <button type="button" className="vc-icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <dl>
        <dt>Built from</dt>
        <dd>
          The {startingPoint?.template ?? "Worker + React"} Template
          {startingPoint && <span className="muted"> · {startingPoint.plain.toLowerCase()}</span>}
        </dd>
        {startingPoint && (
          <>
            <dt>Why that one</dt>
            <dd>{startingPoint.why}</dd>
          </>
        )}
        <dt>Version</dt>
        <dd>{state.version}</dd>
        <dt>Published</dt>
        <dd>{state.published ? `Version ${state.published.version}, at ${appUrl}` : "Not yet"}</dd>
      </dl>
    </div>
  );
}

function PublishPill({ sim, open, onToggle }: { sim: Sim; open: boolean; onToggle(): void }) {
  const { state } = sim;
  const unpublished = hasUnpublishedChanges(state);
  const live = state.published !== null && !unpublished;
  let label = "Publish";
  if (state.published) label = unpublished ? "Publish changes" : "Live";

  return (
    <>
      <button
        type="button"
        className={`vc-publish${live ? " vc-publish-live" : ""}${unpublished ? " vc-publish-changes" : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        {live && <span aria-hidden="true">● </span>}
        {label}
      </button>
      {open && (
        <div className="vc-popover vc-publish-popover" role="dialog" aria-label="Publish">
          {!state.published && (
            <>
              <p>
                <strong>Put {state.appName} online?</strong>
              </p>
              <p className="muted">
                Anyone with the link can use it: <code>{appUrl}</code>. Keep changing it here; people see changes when you publish
                again.
              </p>
              <button type="button" className="vc-next" onClick={sim.publish}>
                Publish
              </button>
            </>
          )}
          {state.published && unpublished && (
            <>
              <p>
                <strong>You've changed it since you published.</strong>
              </p>
              <p className="muted">
                People using the link have version {state.published.version}. Publish to give them version {state.version}.
              </p>
              <button type="button" className="vc-next" onClick={sim.publish}>
                Publish changes
              </button>
            </>
          )}
          {live && (
            <>
              <p>
                <strong>{state.appName} is live</strong>
              </p>
              <p className="vc-link">{appUrl}</p>
              <div className="vc-chips">
                <button type="button" className="vc-chip">
                  Copy the link
                </button>
                <button type="button" className="vc-chip">
                  Send on WhatsApp
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** The latest thing the Agent said, or what it's doing now. */
function Toast({
  state,
  latest,
  working,
  onDismiss,
  onSend,
}: {
  state: SimState;
  latest: AgentMessage | undefined;
  working: boolean;
  onDismiss(): void;
  onSend(text: string): void;
}) {
  if (working) {
    const progress = state.progress;
    return (
      <div className="vc-toast vc-toast-working" role="status">
        <span className="vc-spinner" aria-hidden="true" />
        <span className="vc-toast-text">{state.activity ?? "Working on it…"}</span>
        {progress && (
          <span className="muted vc-toast-step">
            step {Math.min(progress.done + 1, progress.total)} of {progress.total}
          </span>
        )}
      </div>
    );
  }
  if (!latest) return null;
  return (
    <div className={`vc-toast${latest.failed ? " vc-toast-failed" : ""}`} role="status">
      <div className="vc-toast-row">
        <span className="vc-toast-text">
          {latest.failed && <strong>That didn't work. </strong>}
          {lastParagraph(latest.text)}
        </span>
        <button type="button" className="vc-icon" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
      {latest.choices && state.pendingQuestion && (
        <div className="vc-chips">
          {latest.choices.map((choice) => (
            <button key={choice} type="button" className="vc-chip vc-chip-strong" onClick={() => onSend(choice)}>
              {choice}
            </button>
          ))}
        </div>
      )}
      {state.suggestions.length > 0 && (
        <div className="vc-chips">
          {state.suggestions.map((suggestion) => (
            <button key={suggestion} type="button" className="vc-chip" onClick={() => onSend(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The whole Conversation, compact, in a drawer. */
function History({ state, onClose }: { state: SimState; onClose(): void }) {
  return (
    <aside className="vc-drawer" aria-label="History">
      <div className="vc-drawer-head">
        <strong>History</strong>
        <button type="button" className="vc-icon" aria-label="Close the history" onClick={onClose}>
          ×
        </button>
      </div>
      <ol className="vc-history">
        {state.messages.map((message) =>
          message.from === "you" ? (
            <li key={message.id} className="vc-history-you">
              {message.pointedAt && <span className="vc-history-about">About {message.pointedAt}</span>}
              {message.text}
            </li>
          ) : (
            <li key={message.id} className={`vc-history-agent${message.failed ? " vc-history-failed" : ""}`}>
              {message.text && <p>{lastParagraph(message.text)}</p>}
              {message.steps.length > 0 && (
                <ul className="vc-history-steps">
                  {message.steps.map((step, index) => (
                    <li key={index}>
                      <span aria-hidden="true">{stepIcon(step)} </span>
                      {step.label}
                      {step.result && <span className="muted"> · {step.result}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {message.builtVersion !== undefined && <span className="vc-history-version">Version {message.builtVersion}</span>}
            </li>
          ),
        )}
      </ol>
    </aside>
  );
}

const stepIcon = (step: Step) => (step.status === "done" ? "✓" : step.status === "failed" ? "✕" : step.status === "fixing" ? "↻" : "…");

/** The Agent's last paragraph: how the Turn went, rather than what it set out to do. */
function lastParagraph(text: string): string {
  const paragraphs = text.split("\n\n").filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? "";
}
