import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { ApiError, getWorkspace, listFiles } from "./api";
import { ConversationPanel } from "./ConversationPanel";
import { ErrorMessage } from "./ErrorMessage";
import { FileTree } from "./FileTree";
import { useLoad, useTitle } from "./hooks";
import { ProblemsPanel } from "./ProblemsPanel";
import { Link } from "./router";
import { foldersOf } from "./tree";
import { useChecks } from "./useChecks";
import { useConversation } from "./useConversation";
import { useOpenFile } from "./useOpenFile";

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/** Trying again only helps when the platform couldn't be reached or failed, not when it refused. */
const canRetry = (error: ApiError) => error.status === 0 || error.status >= 500;

/** The Workspace page, at `/workspaces/:id`: the file tree, the editor, the problems list and the Conversation. */
export function WorkspacePage({ id }: { id: string }) {
  const loaded = useLoad(() => getWorkspace(id).catch((error: unknown) => (isNotFound(error) ? null : Promise.reject(error))));
  const { state } = loaded;
  const workspace = state.status === "ready" ? state.data : undefined;
  useTitle(workspace?.name ?? "Workspace");

  return (
    <div className="workspace-page">
      <div className="workspace-header">
        <Link to="/" className="back-link">
          <span aria-hidden="true">← </span>
          <span className="visually-hidden">Back to </span>Workspaces
        </Link>
        {workspace && <h1 className="workspace-title">{workspace.name}</h1>}
      </div>
      {state.status === "loading" && <p className="workspace-message muted">Loading the Workspace…</p>}
      {state.status === "failed" && (
        <div className="workspace-message">
          <ErrorMessage error={state.error} retry={loaded.retry} />
        </div>
      )}
      {state.status === "ready" && !workspace && (
        <div className="workspace-message">
          <h1>Workspace not found</h1>
          <p>It may have been deleted.</p>
        </div>
      )}
      {workspace && <WorkspaceView id={workspace.id} />}
    </div>
  );
}

function WorkspaceView({ id }: { id: string }) {
  const headingId = useId();
  const files = useLoad(() => listFiles(id));
  const checks = useChecks(id);
  const conversation = useConversation(id);
  const { state } = conversation;
  // Only the Agent may change files while a Turn runs.
  const locked = state?.turn != null;
  const file = useOpenFile(id, {
    problems: checks.reportIsCurrent ? checks.report?.problems : undefined,
    onSaved: checks.checkSoon,
    locked,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [problemsExpanded, setProblemsExpanded] = useState(true);

  // When a Turn ends, show what the Agent changed: the files, the open file and the Turn's Check and Build.
  // A Turn that ran while the socket was closed shows as a new `lastTurn`.
  const turnKey = state && `${state.turn?.startedAt ?? ""} ${state.lastTurn?.endedAt ?? ""}`;
  const seenTurnKey = useRef<string | null>(null);
  const onTurnEnd = useEffectEvent(() => {
    files.reload();
    void file.reload();
    // The stored reports are the Turn's own Check and Build, unless either didn't run.
    // A Build always follows a Check, so a missing Build runs both.
    const lastTurn = state?.lastTurn;
    if (lastTurn?.checkErrors == null || lastTurn.buildErrors == null) checks.checkNow();
    else checks.showLatest();
  });
  useEffect(() => {
    const previous = seenTurnKey.current;
    seenTurnKey.current = turnKey;
    if (previous !== null && turnKey !== null && turnKey !== previous && !locked) onTurnEnd();
  }, [turnKey, locked]);

  const paths = files.state.status === "ready" ? files.state.data : null;
  const knownPaths = useMemo(() => new Set(paths), [paths]);
  const { opened } = file;
  const openedPath = opened?.path;

  // Open the folders around the file being opened, so the tree shows it selected.
  useEffect(() => {
    if (!openedPath) return;
    setCollapsed((folders) => {
      const closedParents = foldersOf(openedPath).filter((folder) => folders.has(folder));
      if (closedParents.length === 0) return folders;
      const next = new Set(folders);
      for (const folder of closedParents) next.delete(folder);
      return next;
    });
  }, [openedPath]);

  function toggleFolder(folder: string) {
    setCollapsed((folders) => {
      const next = new Set(folders);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  }

  const isOpen = opened?.status === "open";
  let saveStatus = "";
  if (file.saving) saveStatus = "Saving…";
  else if (file.saved && !file.dirty) saveStatus = "Saved";

  return (
    <div className="workspace-layout">
      <nav className="workspace-files" aria-labelledby={`${headingId}-files`}>
        <h2 id={`${headingId}-files`} className="pane-heading">
          Files
        </h2>
        {files.state.status === "loading" && <p className="pane-message muted">Loading the files…</p>}
        {files.state.status === "failed" && (
          <div className="pane-message">
            <ErrorMessage error={files.state.error} retry={files.retry} />
          </div>
        )}
        {paths?.length === 0 && <p className="pane-message muted">This Workspace has no files.</p>}
        {paths && paths.length > 0 && (
          <FileTree
            paths={paths}
            selected={openedPath ?? null}
            collapsed={collapsed}
            onToggle={toggleFolder}
            onOpen={(path) => void file.open(path)}
          />
        )}
      </nav>

      <section className="workspace-editor" aria-labelledby={`${headingId}-editor`}>
        <div className="editor-toolbar">
          <h2 id={`${headingId}-editor`} className="editor-path">
            {openedPath ?? "No file open"}
          </h2>
          {isOpen && file.dirty && (
            <span className="dirty-marker">
              <span aria-hidden="true">● </span>Unsaved changes
            </span>
          )}
          <span className="save-status" role="status">
            {locked ? "Read-only while the Agent is working" : saveStatus}
          </span>
          <button
            type="button"
            className="button button-small"
            onClick={() => void file.save()}
            disabled={!isOpen || !file.dirty || locked}
          >
            Save
          </button>
        </div>
        {file.saveError && (
          <div className="editor-message">
            <ErrorMessage error={file.saveError} />
          </div>
        )}
        {!opened && <p className="editor-message muted">Choose a file to open it.</p>}
        {opened?.status === "opening" && <p className="editor-message muted">Opening {opened.path}…</p>}
        {opened?.status === "failed" && (
          <div className="editor-message">
            <ErrorMessage
              error={opened.error}
              retry={canRetry(opened.error) ? () => void file.open(opened.path) : undefined}
            />
          </div>
        )}
        <div ref={file.editorHost} className="editor-host" hidden={!isOpen} />
      </section>

      <ProblemsPanel
        checks={checks}
        expanded={problemsExpanded}
        onToggle={() => setProblemsExpanded((expanded) => !expanded)}
        canOpen={(path) => knownPaths.has(path)}
        onOpen={(path, line, column) => void file.open(path, { line, column })}
      />

      <ConversationPanel id={id} conversation={conversation} unsavedChanges={isOpen && file.dirty} />
    </div>
  );
}
