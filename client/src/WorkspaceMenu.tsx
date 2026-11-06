import { useId, useRef, useState } from "react";
import { exportUrl, startFresh, toApiError, type ApiError, type Workspace } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DeleteDialog } from "./DeleteDialog";
import { ErrorMessage } from "./ErrorMessage";
import { navigate } from "./router";
import { SecretsDialog } from "./SecretsDialog";

type Dialog = "secrets" | "start-fresh" | "delete";

/**
 * The header's menu: Secrets, Export zip, Start fresh and Delete. It's a
 * popover, so the browser closes it on Escape or a click elsewhere, and a
 * dialog opened from it returns focus to the Menu button.
 */
export function WorkspaceMenu({ workspace, canStartFresh }: { workspace: Workspace; canStartFresh: boolean }) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  function choose(next: Dialog) {
    // Hiding the menu first puts focus back on its button, where the dialog returns it.
    menu.current?.hidePopover();
    setDialog(next);
  }

  async function confirmStartFresh() {
    setError(null);
    try {
      await startFresh(workspace.id);
    } catch (caught) {
      setError(toApiError(caught));
    }
  }

  return (
    <>
      <button type="button" className="button button-small menu-button" popoverTarget={menuId}>
        Menu
      </button>
      <div ref={menu} id={menuId} popover="auto" className="menu">
        <ul className="menu-list">
          <li>
            <button type="button" className="menu-item" onClick={() => choose("secrets")}>
              Secrets
            </button>
          </li>
          <li>
            <a href={exportUrl(workspace.id)} download className="menu-item" onClick={() => menu.current?.hidePopover()}>
              Export zip
            </a>
          </li>
          <li>
            <button type="button" className="menu-item" onClick={() => choose("start-fresh")} disabled={!canStartFresh}>
              Start fresh
            </button>
          </li>
          <li>
            <button type="button" className="menu-item" onClick={() => choose("delete")}>
              Delete
            </button>
          </li>
        </ul>
      </div>
      {error && (
        <div className="workspace-header-message">
          <ErrorMessage error={error} />
        </div>
      )}

      {dialog === "secrets" && <SecretsDialog id={workspace.id} onClose={() => setDialog(null)} />}
      {dialog === "start-fresh" && (
        <ConfirmDialog
          title="Start fresh?"
          confirm="Start fresh"
          onClose={() => setDialog(null)}
          onConfirm={() => void confirmStartFresh()}
        >
          The Agent summarises everything after your first message, then carries on from the summary. The messages it
          summarises won't be shown any more.
        </ConfirmDialog>
      )}
      {dialog === "delete" && (
        <DeleteDialog workspace={workspace} onClose={() => setDialog(null)} onDeleted={() => navigate("/", { unguarded: true })} />
      )}
    </>
  );
}
