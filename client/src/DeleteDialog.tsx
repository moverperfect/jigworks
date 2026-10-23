import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { deleteWorkspace, toApiError, type ApiError, type Workspace } from "./api";
import { ErrorMessage } from "./ErrorMessage";

export function DeleteDialog({
  workspace,
  onClose,
  onDeleted,
}: {
  workspace: Workspace;
  onClose(): void;
  onDeleted(workspace: Workspace): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const matches = typed === workspace.name;

  useEffect(() => {
    // StrictMode runs this twice in development, so don't open it twice.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(workspace.id, typed);
    } catch (caught) {
      const apiError = toApiError(caught);
      // A 404 means it's already gone, which is what the Developer wanted.
      if (apiError.status !== 404) {
        setError(apiError);
        setDeleting(false);
        return;
      }
    }
    dialog.current?.close();
    onDeleted(workspace);
  }

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={onClose}
      onCancel={(event) => {
        if (deleting) event.preventDefault();
      }}
    >
      <form className="form" onSubmit={submit}>
        <h2 id={`${id}-title`}>
          Delete <span className="exact">{workspace.name}</span>?
        </h2>
        <p id={`${id}-description`}>
          This deletes the Workspace's files and its Conversation. It can't be undone.
        </p>
        <div className="field">
          <label htmlFor={`${id}-confirm`}>
            To confirm, type <strong className="exact">{workspace.name}</strong>
          </label>
          <input
            id={`${id}-confirm`}
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        {error && <ErrorMessage error={error} />}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => dialog.current?.close()} disabled={deleting}>
            Cancel
          </button>
          <button type="submit" className="button button-danger" disabled={!matches || deleting}>
            {deleting ? "Deleting…" : "Delete Workspace"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
