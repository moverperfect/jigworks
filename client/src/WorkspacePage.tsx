import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { ApiError, getDeployment, getWorkspace, listFiles, type Workspace } from "./api";
import { appStartedIn, turnProgress } from "./agentMessage";
import { appAreaState, problemsNote } from "./appArea";
import { AppName } from "./AppName";
import { ConversationPanel } from "./ConversationPanel";
import { ErrorMessage } from "./ErrorMessage";
import { FileTree } from "./FileTree";
import { useLoad, useMediaQuery, usePageVisible, useTitle, type Loader } from "./hooks";
import { Menu } from "./Menu";
import { PreviewLogs, PreviewPanel } from "./PreviewPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { PublishControl } from "./PublishControl";
import { publishState } from "./publish";
import { foldersOf } from "./tree";
import { useChecks, type Checks } from "./useChecks";
import { useConversation } from "./useConversation";
import { useOpenFile, type CursorTarget, type OpenFile } from "./useOpenFile";
import { usePreviewFrame, usePreviewProblems } from "./usePreview";
import { useTests, type Tests } from "./useTests";
import { WorkspaceMenu } from "./WorkspaceMenu";

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/** Trying again only helps when the platform couldn't be reached or failed, not when it refused. */
const canRetry = (error: ApiError) => error.status === 0 || error.status >= 500;

/** Below this width the page shows the Conversation and the app one at a time, behind tabs. Matches styles.css. */
const narrowQuery = "(width < 760px)";

type Tab = "conversation" | "app";
const tabs: { tab: Tab; label: string }[] = [
  // The page calls the Conversation "chat" where it needs a short name (ADR 0018).
  { tab: "conversation", label: "Chat" },
  { tab: "app", label: "App" },
];

/** What the page needs from App for the bar along the top. */
interface BarProps {
  /** The bar, where the page puts the Workspace's name, Publish and the menu. */
  bar: HTMLElement | null;
  /** Who's signed in, for the menu. */
  account: ReactNode;
}

/**
 * The app's page, at `/workspaces/:id`: the app's name, Publish and the menu
 * in the bar along the top; the Conversation on the left; and the app on the
 * right, or its code behind "See the code" (ADR 0018). The page calls a
 * Workspace an app.
 */
export function WorkspacePage({ id, bar, account }: { id: string } & BarProps) {
  const loaded = useLoad(() => getWorkspace(id).catch((error: unknown) => (isNotFound(error) ? null : Promise.reject(error))));
  const { state } = loaded;
  const workspace = state.status === "ready" ? state.data : undefined;
  useTitle(workspace?.name ?? "Your app");
  // The Agent names an app when it starts it, and undoing that Turn takes the name back (ADR 0018), so the page looks
  // for the name whenever no Turn is running, and once `start_app` has finished.
  const lookForName = () => {
    getWorkspace(id).then(
      (latest) => loaded.update(() => latest),
      () => {},
    );
  };

  return (
    <div className="workspace-page">
      {!workspace && bar && createPortal(<Menu account={account} />, bar)}
      {state.status === "loading" && <p className="workspace-message muted">Loading your app…</p>}
      {state.status === "failed" && (
        <div className="workspace-message">
          <ErrorMessage error={state.error} retry={loaded.retry} />
        </div>
      )}
      {state.status === "ready" && !workspace && (
        <div className="workspace-message">
          <h1>App not found</h1>
          <p>It may have been deleted.</p>
        </div>
      )}
      {workspace && (
        <WorkspaceView
          workspace={workspace}
          lookForName={lookForName}
          onRenamed={(renamed) => loaded.update(() => renamed)}
          bar={bar}
          account={account}
        />
      )}
    </div>
  );
}

function WorkspaceView({
  workspace,
  lookForName,
  onRenamed,
  bar,
  account,
}: { workspace: Workspace; lookForName(): void; onRenamed(workspace: Workspace): void } & BarProps) {
  const { id } = workspace;
  const pageId = useId();
  const files = useLoad(() => listFiles(id));
  const checks = useChecks(id, workspace.template !== null);
  const tests = useTests(id);
  const conversation = useConversation(id);
  const { state } = conversation;
  // Only the Agent may change files while a Turn runs.
  const locked = state?.turn != null;
  const file = useOpenFile(id, {
    problems: checks.reportIsCurrent ? checks.report?.problems : undefined,
    onSaved: checks.checkSoon,
    locked,
  });

  const narrow = useMediaQuery(narrowQuery);
  const [tab, setTab] = useState<Tab>("conversation");
  const [codeShown, setCodeShown] = useState(false);
  // Whether the right-hand pane, with the app or its code, is on screen.
  const rightShown = !narrow || tab === "app";
  // A hidden app area has no frame, so the app runs no code there.
  const preview = usePreviewFrame(id, checks.build, rightShown && !codeShown);
  const deployment = useLoad(() => getDeployment(id));
  const deployed = deployment.state.status === "ready" ? deployment.state.data : null;
  const publishing = deployed && publishState(deployed.hash, preview.goodHash);
  // The last failed Turn's end, once the Developer left it for now: until the next Turn ends, the page shows the app as it was.
  const [leftTurnEndedAt, setLeftTurnEndedAt] = useState<string | null>(null);
  const failureLeft = leftTurnEndedAt !== null && leftTurnEndedAt === state?.lastTurn?.endedAt;
  const areaState = appAreaState(state, preview.built, publishing, failureLeft);
  const progress = state?.turn ? turnProgress(conversation.messages, state.turn) : null;
  // The app's server errors since its latest Build, beside the app while it shows, until the Developer hides them (#104).
  const appShown = rightShown && !codeShown && (areaState === "ready" || areaState === "live");
  const previewProblems = usePreviewProblems(id, appShown);
  // The time of the newest error the Developer hid.
  const [problemsHiddenThrough, setProblemsHiddenThrough] = useState<string | null>(null);
  const problems = problemsNote(previewProblems, areaState, preview.goodHash, problemsHiddenThrough);
  const [logsExpanded, setLogsExpanded] = useState(true);
  const logsToggle = useRef<HTMLButtonElement>(null);

  // Another tab may have built or published meanwhile, so look again when the page comes back into view.
  const pageVisible = usePageVisible();
  const wasVisible = useRef(pageVisible);
  const onPageShown = useEffectEvent(() => {
    deployment.reload();
    preview.refreshInfo();
  });
  useEffect(() => {
    if (pageVisible && !wasVisible.current) onPageShown();
    wasVisible.current = pageVisible;
  }, [pageVisible]);

  const conversationPanel = useRef<HTMLDivElement>(null);
  const focusTab = (which: Tab) => document.getElementById(`${pageId}-${which}-tab`)?.focus();
  // From the end of a Turn until a new successful Build arrives: the Preview's Build when the Turn ended. Null when not waiting.
  const waitingForBuild = useRef<{ goodHash: string | null } | null>(null);

  // When a Turn ends, show what the Agent changed: the files, the open file and the Turn's Check, Build and tests.
  // A Turn that ran while the socket was closed shows as a new `lastTurn`.
  const turnKey = state && `${state.turn?.startedAt ?? ""} ${state.lastTurn?.endedAt ?? ""}`;
  const seenTurnKey = useRef<string | null>(null);
  const findName = useEffectEvent(lookForName);
  const onTurnEnd = useEffectEvent(() => {
    waitingForBuild.current = { goodHash: preview.goodHash };
    files.reload();
    void file.reload();
    // The stored reports are the Turn's own Check and Build, unless either didn't run.
    // A Build always follows a Check, so a missing Build runs both. Before the app
    // has started there's nothing to check.
    const lastTurn = state?.lastTurn;
    if (lastTurn?.noApp) {
      // Undoing the Turn that started the app took its Preview with it (ADR 0018), which isn't a change to show.
      if (lastTurn.restored) {
        waitingForBuild.current = null;
        preview.forget();
      }
      return;
    }
    if (lastTurn?.checkErrors == null || lastTurn.buildErrors == null) checks.checkNow();
    else checks.showLatest();
    tests.showLatest();
  });
  useEffect(() => {
    const previous = seenTurnKey.current;
    seenTurnKey.current = turnKey;
    if (locked) waitingForBuild.current = null;
    if (turnKey === null || turnKey === previous || locked) return;
    // Also when the page first sees the Conversation: a first Turn may have named the app before the socket connected.
    findName();
    if (previous !== null) onTurnEnd();
  }, [turnKey, locked]);

  // The first Turn goes on after naming the app, so the header shows the name from then.
  const appStarted = appStartedIn(conversation.messages);
  useEffect(() => {
    if (appStarted) findName();
  }, [appStarted]);

  // A Turn changed the app when a new Build succeeded, so bring the App tab forward to show it.
  // Focus left in the Conversation would be hidden with it, so it moves to the App tab.
  const onAppChanged = useEffectEvent(() => {
    const focusInConversation = conversationPanel.current?.contains(document.activeElement) ?? false;
    setTab("app");
    if (narrow && focusInConversation) focusTab("app");
  });
  useEffect(() => {
    const waiting = waitingForBuild.current;
    if (!waiting || preview.goodHash === waiting.goodHash) return;
    waitingForBuild.current = null;
    onAppChanged();
  }, [preview.goodHash]);

  // Changing between the app and its code swaps the button that did it for the one that changes back.
  const showCodeButton = useRef<HTMLButtonElement>(null);
  const showAppButton = useRef<HTMLButtonElement>(null);
  function swapView(toCode: boolean) {
    flushSync(() => setCodeShown(toCode));
    (toCode ? showAppButton : showCodeButton).current?.focus();
  }

  // "See the details" beside the app: the code, with the logs open and focused.
  function seeDetails() {
    flushSync(() => {
      setCodeShown(true);
      setLogsExpanded(true);
    });
    logsToggle.current?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // There are two tabs, so either arrow key moves to the other.
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = tab === "conversation" ? "app" : "conversation";
    setTab(next);
    focusTab(next);
  }

  const isOpen = file.opened?.status === "open";
  const canStartFresh = conversation.idle && conversation.messages.length > 0;
  // On a phone, each pane is a tab's panel.
  const panel = (which: Tab) =>
    narrow
      ? { id: `${pageId}-${which}-panel`, role: "tabpanel", "aria-labelledby": `${pageId}-${which}-tab`, hidden: tab !== which }
      : {};

  return (
    <>
      {/* One bar along the top, as in Variant E: Jigworks, then the Workspace's name, publishing and the menu. */}
      {bar &&
        createPortal(
          <>
            <AppName workspace={workspace} onRenamed={onRenamed} />
            <PublishControl
              id={id}
              name={workspace.name}
              deployment={deployment}
              latestGoodHash={preview.goodHash}
              locked={locked}
            />
            <WorkspaceMenu workspace={workspace} canStartFresh={canStartFresh} account={account} />
          </>,
          bar,
        )}

      {narrow && (
        <div className="workspace-tabs" role="tablist" aria-label="Chat and app" onKeyDown={onTabKeyDown}>
          {tabs.map((option) => (
            <button
              key={option.tab}
              type="button"
              role="tab"
              id={`${pageId}-${option.tab}-tab`}
              className="workspace-tab"
              aria-selected={tab === option.tab}
              aria-controls={`${pageId}-${option.tab}-panel`}
              tabIndex={tab === option.tab ? 0 : -1}
              onClick={() => setTab(option.tab)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      <div className="workspace-layout">
        <div ref={conversationPanel} className="workspace-pane" {...panel("conversation")}>
          <ConversationPanel
            id={id}
            conversation={conversation}
            unsavedChanges={isOpen && file.dirty}
            visible={!narrow || tab === "conversation"}
            failureLeft={failureLeft}
            leaveFailure={() => setLeftTurnEndedAt(state?.lastTurn?.endedAt ?? null)}
          />
        </div>

        <div className="workspace-pane" {...panel("app")}>
          <section className="app-area" aria-labelledby={`${pageId}-app-heading`} hidden={codeShown}>
            <h2 id={`${pageId}-app-heading`} className="visually-hidden">
              Your app
            </h2>
            <PreviewPanel
              preview={preview}
              state={areaState}
              publishing={publishing}
              progress={progress}
              openToEveryone={deployed?.openToEveryone ?? false}
              onShowCode={() => swapView(true)}
              showCodeButton={showCodeButton}
              narrow={narrow}
              problemLines={problems?.lines ?? null}
              onSeeDetails={seeDetails}
              onHideProblems={() => {
                if (problems) setProblemsHiddenThrough(problems.newest);
                // The note goes with the button.
                showCodeButton.current?.focus();
              }}
            />
          </section>
          {/* Kept on the page while hidden, so the editor keeps its file and any unsaved changes. */}
          <CodeView
            id={id}
            hidden={!codeShown}
            logsVisible={rightShown && codeShown}
            logsExpanded={logsExpanded}
            onToggleLogs={() => setLogsExpanded((shown) => !shown)}
            logsToggle={logsToggle}
            files={files}
            file={file}
            checks={checks}
            tests={tests}
            locked={locked}
            onShowApp={() => swapView(false)}
            showAppButton={showAppButton}
          />
        </div>
      </div>
    </>
  );
}

/** The code, behind "See the code": the file tree, the editor, the problems list with the tests, and the Preview's logs. */
function CodeView({
  id,
  hidden,
  logsVisible,
  logsExpanded,
  onToggleLogs,
  logsToggle,
  files,
  file,
  checks,
  tests,
  locked,
  onShowApp,
  showAppButton,
}: {
  id: string;
  hidden: boolean;
  logsVisible: boolean;
  logsExpanded: boolean;
  onToggleLogs(): void;
  logsToggle: RefObject<HTMLButtonElement | null>;
  files: Loader<string[]>;
  file: OpenFile;
  checks: Checks;
  tests: Tests;
  locked: boolean;
  onShowApp(): void;
  showAppButton: RefObject<HTMLButtonElement | null>;
}) {
  const headingId = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [problemsExpanded, setProblemsExpanded] = useState(true);
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

  function showFile(path: string, cursor?: CursorTarget) {
    void file.open(path, cursor);
  }

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
    <section className="code-view" aria-labelledby={`${headingId}-heading`} hidden={hidden}>
      <div className="app-toolbar">
        <button ref={showAppButton} type="button" className="button button-small" onClick={onShowApp}>
          <span aria-hidden="true">← </span>Back to your app
        </button>
        <h2 id={`${headingId}-heading`} className="code-view-heading">
          The code
        </h2>
      </div>

      <div className="code-layout">
        <nav className="workspace-files" aria-labelledby={`${headingId}-files`}>
          <h3 id={`${headingId}-files`} className="pane-heading">
            Files
          </h3>
          {files.state.status === "loading" && <p className="pane-message muted">Loading the files…</p>}
          {files.state.status === "failed" && (
            <div className="pane-message">
              <ErrorMessage error={files.state.error} retry={files.retry} />
            </div>
          )}
          {paths?.length === 0 && <p className="pane-message muted">This app has no files.</p>}
          {paths && paths.length > 0 && (
            <FileTree
              paths={paths}
              selected={openedPath ?? null}
              collapsed={collapsed}
              onToggle={toggleFolder}
              onOpen={(path) => showFile(path)}
            />
          )}
        </nav>

        <section className="workspace-editor" aria-labelledby={`${headingId}-path`}>
          <div className="editor-toolbar">
            <h3 id={`${headingId}-path`} className="editor-path">
              {openedPath ?? "No file open"}
            </h3>
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

        <div className="code-reports">
          <ProblemsPanel
            checks={checks}
            tests={tests}
            expanded={problemsExpanded}
            onToggle={() => setProblemsExpanded((expanded) => !expanded)}
            canOpen={(path) => knownPaths.has(path)}
            onOpen={(path, line, column) => showFile(path, { line, column })}
          />
          <PreviewLogs id={id} visible={logsVisible} expanded={logsExpanded} onToggle={onToggleLogs} toggleButton={logsToggle} />
        </div>
      </div>
    </section>
  );
}
