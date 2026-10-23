import { useRef, useState } from "react";
import { exportUrl, listTemplates, listWorkspaces, type Workspace } from "./api";
import { DeleteDialog } from "./DeleteDialog";
import { ErrorMessage } from "./ErrorMessage";
import { useLoad, useTitle } from "./hooks";
import { NewWorkspaceForm } from "./NewWorkspaceForm";
import { Link, workspacePath } from "./router";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const formatDate = (iso: string) => dateFormat.format(new Date(iso));

export function HomePage() {
  useTitle("Workspaces");
  const templates = useLoad(listTemplates);
  const workspaces = useLoad(listWorkspaces);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listHeading = useRef<HTMLHeadingElement>(null);

  function templateName(id: string): string {
    const known = templates.state.status === "ready" ? templates.state.data : [];
    return known.find((t) => t.id === id)?.name ?? id;
  }

  function created(workspace: Workspace) {
    // While the list is still loading, its answer may predate this Workspace, so load it again.
    if (workspaces.state.status === "ready") workspaces.update((list) => [workspace, ...list]);
    else workspaces.retry();
    setAnnouncement(`Created “${workspace.name}”.`);
  }

  function deleted(workspace: Workspace) {
    setWorkspaceToDelete(null);
    workspaces.update((list) => list.filter((w) => w.id !== workspace.id));
    setAnnouncement(`Deleted “${workspace.name}”.`);
    // Its Delete button is about to disappear, so move focus somewhere that stays.
    listHeading.current?.focus();
  }

  const list = workspaces.state;

  return (
    <>
      <h1>Workspaces</h1>

      <NewWorkspaceForm templates={templates} onCreated={created} />

      <section className="section" aria-labelledby="your-workspaces">
        <h2 id="your-workspaces" ref={listHeading} tabIndex={-1}>
          Your Workspaces
        </h2>
        {list.status === "loading" && <p className="muted">Loading your Workspaces…</p>}
        {list.status === "failed" && <ErrorMessage error={list.error} retry={workspaces.retry} />}
        {list.status === "ready" && list.data.length === 0 && (
          <p className="empty">You don't have any Workspaces yet. Create one with the New Workspace form.</p>
        )}
        {list.status === "ready" && list.data.length > 0 && (
          <ul className="workspace-list">
            {list.data.map((workspace) => (
              <li key={workspace.id} className="workspace card">
                <div className="workspace-details">
                  <h3 className="workspace-name">{workspace.name}</h3>
                  <p className="muted">
                    {templateName(workspace.template)} · Created{" "}
                    <time dateTime={workspace.createdAt}>{formatDate(workspace.createdAt)}</time>
                  </p>
                </div>
                <div className="actions">
                  <Link to={workspacePath(workspace.id)} className="button button-primary">
                    Open<span className="visually-hidden"> {workspace.name}</span>
                  </Link>
                  <a href={exportUrl(workspace.id)} download className="button">
                    Export zip<span className="visually-hidden"> of {workspace.name}</span>
                  </a>
                  <button type="button" className="button" onClick={() => setWorkspaceToDelete(workspace)}>
                    Delete<span className="visually-hidden"> {workspace.name}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p role="status" className="visually-hidden">
        {announcement}
      </p>

      {workspaceToDelete && <DeleteDialog workspace={workspaceToDelete} onClose={() => setWorkspaceToDelete(null)} onDeleted={deleted} />}
    </>
  );
}
