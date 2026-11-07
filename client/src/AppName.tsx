import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { validateWorkspaceName } from "../../src/shared/workspace-name.ts";
import { ApiError, renameWorkspace, toApiError, type Workspace } from "./api";
import { ErrorMessage } from "./ErrorMessage";

/**
 * The app's name in the header, which the Developer renames in place: the
 * name is a button that becomes a field. Enter or leaving the field saves,
 * and Escape, or leaving it with a name it can't have, puts the name back.
 * Until the Agent has started the app, whose name would replace the
 * Developer's, the name can't change.
 */
export function AppName({ workspace, onRenamed }: { workspace: Workspace; onRenamed(workspace: Workspace): void }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Whether focus goes back to the name when the field closes: not when the Developer left it for somewhere else.
  const refocus = useRef(false);
  // Set once the field is done with, so the blur as it closes doesn't save again.
  const closing = useRef(false);

  useEffect(() => {
    if (editing) input.current?.select();
    else if (refocus.current) button.current?.focus();
  }, [editing]);

  function open() {
    closing.current = false;
    refocus.current = false;
    setText(workspace.name);
    setError(null);
    setEditing(true);
  }

  function close(returnFocus: boolean) {
    closing.current = true;
    refocus.current = returnFocus && document.activeElement === input.current;
    setError(null);
    setEditing(false);
  }

  async function save(returnFocus: boolean) {
    if (closing.current || saving) return;
    const name = text.trim();
    if (name === workspace.name) return close(returnFocus);
    const invalid = validateWorkspaceName(name);
    // Leaving the field is no time to ask for a better name.
    if (invalid && !returnFocus) return close(false);
    if (invalid) return setError(new ApiError(invalid, 400));
    setSaving(true);
    setError(null);
    try {
      onRenamed(await renameWorkspace(workspace.id, name));
      close(returnFocus);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    // Escape here doesn't close anything else.
    event.preventDefault();
    if (!saving) close(true);
  }

  if (workspace.template === null) return <h1 className="workspace-title exact">{workspace.name}</h1>;

  if (!editing) {
    return (
      <h1 className="workspace-title">
        <button ref={button} type="button" className="app-name exact" title="Rename" onClick={open}>
          {workspace.name}
        </button>
      </h1>
    );
  }

  return (
    <form
      className="workspace-title app-name-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void save(true);
      }}
    >
      <input
        ref={input}
        type="text"
        className="app-name-input"
        aria-label="App name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void save(false)}
        readOnly={saving}
        autoComplete="off"
        // Opened by the Developer, so focus belongs here.
        autoFocus
      />
      {error && (
        <div id={`${id}-error`}>
          <ErrorMessage error={error} />
        </div>
      )}
    </form>
  );
}
