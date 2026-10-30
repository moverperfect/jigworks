import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { BuildReport } from "../../src/shared/build-report.ts";
import { previewTabUrl } from "./api";
import { ErrorMessage } from "./ErrorMessage";
import { formatTime } from "./ProblemsPanel";
import { usePreviewFrame, usePreviewLogs } from "./usePreview";

const errorLevels = new Set(["error", "exception", "unhandledrejection", "console.error"]);

/** A log level's colour, using the problems list's severities. */
const levelTone = (level: string) => (errorLevels.has(level) ? "error" : level === "warn" ? "warning" : "message");

/** A path on the Preview from what the Developer typed: `notes` opens `/notes`. */
function toPath(typed: string): string {
  const trimmed = typed.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The Preview pane: the latest successful Build in a frame, the path it shows, and its logs. */
export function PreviewPanel({
  id,
  build,
  visible,
  panelId,
  tabId,
}: {
  id: string;
  build: BuildReport | null;
  /** Whether the pane's tab is selected. */
  visible: boolean;
  panelId: string;
  tabId: string;
}) {
  const pathId = useId();
  const preview = usePreviewFrame(id, build, visible);
  const [typed, setTyped] = useState("/");
  const info = preview.info.status === "ready" ? preview.info.data : null;
  const host = info && new URL(info.url).hostname;
  const ready = info?.ready ?? false;

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
    <section id={panelId} className="workspace-preview" role="tabpanel" aria-labelledby={tabId} hidden={!visible}>
      <h2 className="visually-hidden">Preview</h2>
      <div className="editor-toolbar">
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
        <span className="save-status" role="status">
          {preview.loading && ready ? "Loading…" : ""}
        </span>
      </div>

      <div className="preview-view">
        {preview.info.status === "loading" && <p className="editor-message muted">Loading the Preview…</p>}
        {preview.info.status === "failed" && (
          <div className="editor-message">
            <ErrorMessage error={preview.info.error} retry={preview.retryInfo} />
          </div>
        )}
        {info && !ready && (
          <p className="editor-message muted">The Preview starts after the Workspace's first successful Build.</p>
        )}
        {preview.error && (
          <div className="editor-message">
            <ErrorMessage error={preview.error} retry={() => reload()} />
          </div>
        )}
        {preview.refused && (
          <div className="editor-message">
            <div className="message message-notice" role="alert">
              <p>This browser won't keep the Preview signed in inside the page. Open it in a new tab instead.</p>
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
            title="Preview"
            className="preview-frame"
            hidden={preview.refused}
            onLoad={preview.loaded}
          />
        )}
      </div>

      <PreviewLogs id={id} visible={visible} />
    </section>
  );
}

/** The Preview's server logs and front-end errors, newest last, which follow new lines unless the Developer scrolls up. */
function PreviewLogs({ id, visible }: { id: string; visible: boolean }) {
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
