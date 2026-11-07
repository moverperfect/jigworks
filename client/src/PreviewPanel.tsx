import { useId, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { previewTabUrl } from "./api";
import { stepsDone, type TurnProgress } from "./agentMessage";
import { appAreaNotes, type AppAreaState } from "./appArea";
import type { PublishState } from "./publish";
import { StepList } from "./ConversationPanel";
import { ErrorMessage } from "./ErrorMessage";
import { formatTime } from "./ProblemsPanel";
import { usePreviewLogs, type PreviewFrame } from "./usePreview";

const errorLevels = new Set(["error", "exception", "unhandledrejection", "console.error"]);

/** A log level's colour, using the problems list's severities. */
const levelTone = (level: string) => (errorLevels.has(level) ? "error" : level === "warn" ? "warning" : "message");

/** A path on the Preview from what the Developer typed: `notes` opens `/notes`. */
function toPath(typed: string): string {
  const trimmed = typed.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

type Device = "phone" | "computer";
const devices: { device: Device; label: string }[] = [
  { device: "phone", label: "Phone" },
  { device: "computer", label: "Computer" },
];

/**
 * The app view: the Preview in a Phone or Computer view, the path it shows,
 * Open in a new tab, and "See the code". The page says "your app" for the
 * Preview (ADR 0018).
 */
export function PreviewPanel({
  preview,
  state,
  publishing,
  progress,
  openToEveryone,
  onShowCode,
  showCodeButton,
}: {
  preview: PreviewFrame;
  state: AppAreaState;
  /** The publish state, or null until the page knows it. */
  publishing: PublishState | null;
  /** How far the running Turn has got, or null when none is running. */
  progress: TurnProgress | null;
  /** Whether the Installation's Deployments are open to everyone. */
  openToEveryone: boolean;
  onShowCode(): void;
  showCodeButton: Ref<HTMLButtonElement>;
}) {
  const pathId = useId();
  const [typed, setTyped] = useState("/");
  const [device, setDevice] = useState<Device>("computer");
  const info = preview.info.status === "ready" ? preview.info.data : null;
  const host = info && new URL(info.url).hostname;
  const ready = info?.ready ?? false;
  const note = appAreaNotes(state, publishing, progress, openToEveryone);

  function reload(event?: FormEvent) {
    event?.preventDefault();
    const path = toPath(typed);
    setTyped(path);
    preview.load(path);
  }

  function openInTab() {
    // Opened within the click, so popup blockers allow it. The platform makes the tab's own sign-in link.
    if (host) window.open(previewTabUrl(host, toPath(typed)), "_blank", "noopener");
  }

  return (
    <>
      <div className="app-toolbar">
        <div className="segmented" role="group" aria-label="Show your app on">
          {devices.map((option) => (
            <button
              key={option.device}
              type="button"
              className="button button-small"
              aria-pressed={device === option.device}
              onClick={() => setDevice(option.device)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <form className="preview-address" onSubmit={reload}>
          <label htmlFor={pathId} className="preview-field">
            <span className="visually-hidden">Path to open on </span>
            {host && <span className="preview-host">{host}</span>}
            <input
              id={pathId}
              type="text"
              className="preview-path"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button type="submit" className="button button-small" disabled={!ready}>
            Reload
          </button>
        </form>
        <button type="button" className="button button-small" onClick={openInTab} disabled={!ready}>
          Open in a new tab
        </button>
        <button ref={showCodeButton} type="button" className="button button-small app-toolbar-end" onClick={onShowCode}>
          See the code
        </button>
      </div>

      {/* The app on a Paper sheet, held in the jig: its brackets and their label say what's happening to it. */}
      <div className={`preview-view preview-${device}`} data-state={state}>
        {/* Always there, so screen readers hear each change of state. */}
        <p className="jig-label" role="status">
          {ready ? [note.beside, preview.loading ? "Loading…" : ""].filter(Boolean).join(" ") : state === "first-build" ? note.beside : ""}
        </p>
        {preview.info.status === "loading" && <p className="editor-message muted">Loading your app…</p>}
        {preview.info.status === "failed" && (
          <div className="editor-message">
            <ErrorMessage error={preview.info.error} retry={preview.retryInfo} />
          </div>
        )}
        {info && !ready && (state === "first-build" && progress ? <FirstBuild progress={progress} /> : <p className="app-instead">{note.instead}</p>)}
        {preview.error && (
          <div className="editor-message">
            <ErrorMessage error={preview.error} retry={() => reload()} />
          </div>
        )}
        {preview.refused && (
          <div className="editor-message">
            <div className="message message-notice" role="alert">
              <p>This browser won't keep your app signed in inside the page. Open it in a new tab instead.</p>
              <button type="button" className="button" onClick={openInTab}>
                Open in a new tab
              </button>
            </div>
          </div>
        )}
        {preview.src && (
          // No `sandbox`, so the app's scripts and cookies work. Each link gets a new frame, which leaves no history entry.
          <iframe
            key={preview.src}
            ref={preview.frame}
            src={preview.src}
            title="Your app"
            className="preview-frame"
            hidden={preview.refused}
            onLoad={preview.loaded}
          />
        )}
      </div>
    </>
  );
}

/** The first build's progress, in place of the app: the current step in large type, and the steps done so far. */
function FirstBuild({ progress }: { progress: TurnProgress }) {
  const { current, steps } = progress;
  return (
    <div className="first-build">
      <p className="app-instead" role="status">
        {current}…
      </p>
      {steps.length > 0 && (
        <>
          <div className="first-build-progress" aria-hidden="true">
            <span style={{ width: `${Math.max(2, (steps.filter((step) => step.done).length / steps.length) * 100)}%` }} />
          </div>
          <p className="first-build-count">{stepsDone(steps)}</p>
          <StepList steps={steps.filter((step) => step.done)} />
        </>
      )}
    </div>
  );
}

/** The Preview's server logs and front-end errors, newest last, which follow new lines unless the Developer scrolls up. */
export function PreviewLogs({ id, visible }: { id: string; visible: boolean }) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(true);
  const { logs, error, refresh } = usePreviewLogs(id, visible && expanded);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = body.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [logs]);

  return (
    <section className="preview-logs" aria-labelledby={`${headingId}-heading`}>
      <div className="problems-header">
        <h3 id={`${headingId}-heading`} className="problems-heading">
          <button
            type="button"
            className="problems-toggle"
            aria-expanded={expanded}
            aria-controls={`${headingId}-body`}
            onClick={() => setExpanded((shown) => !shown)}
          >
            <span className="chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
            Logs
          </button>
        </h3>
      </div>
      <div
        ref={body}
        id={`${headingId}-body`}
        className="problems-body logs-body"
        hidden={!expanded}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {error && <ErrorMessage error={error} retry={refresh} />}
        {!logs && !error && <p className="problems-empty">Loading the logs…</p>}
        {logs?.length === 0 && <p className="problems-empty">Nothing logged yet.</p>}
        {logs && logs.length > 0 && (
          <ol className="log-list">
            {logs.map((log, index) => (
              <li key={index} className="log-line">
                <time dateTime={log.at} className="log-detail">
                  {formatTime(log.at)}
                </time>
                <span className="log-detail">{log.source}</span>
                <span className={`log-level severity severity-${levelTone(log.level)}`}>{log.level}</span>
                <span className="log-message">{log.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
