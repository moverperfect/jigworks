import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { listSecrets, removeSecret, setSecret, toApiError, type ApiError, type Secret } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorMessage } from "./ErrorMessage";
import { useLoad } from "./hooks";
import { formatTime } from "./ProblemsPanel";

/** The Workspace header's Secrets button, which opens the Secrets dialog. */
export function SecretsButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button button-small secrets-button" onClick={() => setOpen(true)}>
        Secrets
      </button>
      {open && <SecretsDialog id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * A Workspace's secrets (ADR 0016): their names, a form to add or replace
 * one, and Remove. A value goes in and is never shown again.
 */
function SecretsDialog({ id, onClose }: { id: string; onClose(): void }) {
  const headingId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const loaded = useLoad(() => listSecrets(id));
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [removing, setRemoving] = useState<Secret | null>(null);
  const secrets = loaded.state.status === "ready" ? loaded.state.data : [];
  const replacing = secrets.some((secret) => secret.name === name.trim());

  useEffect(() => {
    // StrictMode runs this twice in development, so don't open it twice.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setSecret(id, name.trim(), value);
      setName("");
      setValue("");
      loaded.reload();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove(secret: Secret) {
    setError(null);
    try {
      await removeSecret(id, secret.name);
      loaded.reload();
    } catch (caught) {
      setError(toApiError(caught));
    }
  }

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby={`${headingId}-title`} onClose={onClose}>
      <div className="form">
        <h2 id={`${headingId}-title`}>Secrets</h2>
        <p className="hint">
          Your app reads each secret from <code>env</code> by its name, in the Preview and the Deployment. The Agent sees
          only the names. A value is never shown again once saved.
        </p>
        {loaded.state.status === "failed" && <ErrorMessage error={loaded.state.error} retry={loaded.retry} />}
        {loaded.state.status === "ready" && secrets.length === 0 && <p className="hint">No secrets yet.</p>}
        {secrets.length > 0 && (
          <ul className="secret-list" aria-label="Secrets">
            {secrets.map((secret) => (
              <li key={secret.name} className="secret">
                <span className="secret-name">{secret.name}</span>
                <span className="hint">set {formatTime(secret.updatedAt)}</span>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => {
                    setName(secret.name);
                    setValue("");
                    nameField.current?.focus();
                  }}
                >
                  Replace
                </button>
                <button type="button" className="button button-small" onClick={() => setRemoving(secret)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="form" onSubmit={save}>
          <div className="field">
            <label htmlFor={`${headingId}-name`}>Name</label>
            <input
              ref={nameField}
              id={`${headingId}-name`}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="API_KEY"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />
          </div>
          <div className="field">
            <label htmlFor={`${headingId}-value`}>Value</label>
            <input
              id={`${headingId}-value`}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          {error && <ErrorMessage error={error} />}
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => dialog.current?.close()}>
              Close
            </button>
            <button type="submit" className="button button-primary" disabled={saving || !name.trim() || !value}>
              {saving ? "Saving…" : replacing ? "Replace" : "Add"}
            </button>
          </div>
        </form>
      </div>
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirm="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        >
          Your app stops getting it in the Preview and the Deployment at once.
        </ConfirmDialog>
      )}
    </dialog>
  );
}
