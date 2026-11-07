import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createWorkspace, listWorkspaces, toApiError, type ApiError } from "./api";
import { changedWhen } from "./changed";
import { sendsMessage } from "./composer";
import { ErrorMessage } from "./ErrorMessage";
import { useLoad, useTitle } from "./hooks";
import { Link, navigate, workspacePath } from "./router";

/** Ideas a Developer can pick, to see the kind of thing Jigworks makes. */
const ideas = [
  "A sign-up sheet for my running club's Sunday runs",
  "A page where neighbours can borrow my lawnmower",
  "A rota for who's cleaning the office kitchen",
];

/**
 * The start page, at `/`: "What would you like to make?", a message box held
 * in the jig's brackets, example ideas, and the Developer's apps (ADR 0018).
 * Sending creates the app and goes to its page, where the Agent is already
 * working on it.
 */
export function StartPage() {
  useTitle("What would you like to make?");
  const id = useId();
  const workspaces = useLoad(listWorkspaces);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      const workspace = await createWorkspace(text);
      navigate(workspacePath(workspace.id));
    } catch (caught) {
      setError(toApiError(caught));
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!sendsMessage(event)) return;
    event.preventDefault();
    void send();
  }

  // An idea goes in the box rather than straight to the Agent, so the Developer can make it their own first.
  function pick(idea: string) {
    setText(idea);
    input.current?.focus();
  }

  const list = workspaces.state;

  return (
    <div className="start">
      <h1 id={`${id}-question`} className="start-question">
        What would you like to make?
      </h1>
      <p id={`${id}-lede`}>Say it in your own words. The Agent builds it, and you can change anything by asking.</p>

      <form className="composer start-composer" data-sending={sending || undefined} onSubmit={(event) => void send(event)}>
        <textarea
          ref={input}
          className="composer-input"
          rows={3}
          value={text}
          placeholder="A booking page for the village hall"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-labelledby={`${id}-question`}
          aria-describedby={`${id}-lede`}
          readOnly={sending}
        />
        {error && <ErrorMessage error={error} />}
        <div className="composer-actions">
          <p className="hint">Shift+Enter starts a new line</p>
          <button type="submit" className="button button-primary" disabled={sending}>
            {sending ? "Starting…" : "Make it"}
          </button>
        </div>
      </form>

      <section className="start-ideas" aria-labelledby={`${id}-ideas`}>
        <h2 id={`${id}-ideas`} className="hint">
          Or start from one of these
        </h2>
        <ul className="start-list">
          {ideas.map((idea) => (
            <li key={idea}>
              <button type="button" className="link-button start-idea" onClick={() => pick(idea)}>
                {idea}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="start-apps" aria-labelledby={`${id}-apps`}>
        <h2 id={`${id}-apps`}>Your apps</h2>
        {list.status === "loading" && <p className="muted">Loading your apps…</p>}
        {list.status === "failed" && <ErrorMessage error={list.error} retry={workspaces.retry} />}
        {list.status === "ready" && list.data.length === 0 && <p className="muted">The apps you make will be listed here.</p>}
        {list.status === "ready" && list.data.length > 0 && (
          <ul className="start-list">
            {list.data.map((workspace) => (
              <li key={workspace.id} className="start-app">
                <Link to={workspacePath(workspace.id)} className="start-app-name exact">
                  {workspace.name}
                </Link>
                {workspace.publishedAt ? <span className="start-app-live">Live</span> : <span className="muted">Not published</span>}
                <time className="start-app-changed muted" dateTime={workspace.changedAt}>
                  {changedWhen(workspace.changedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
