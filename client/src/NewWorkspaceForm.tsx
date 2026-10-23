import { useId, useRef, useState, type FormEvent } from "react";
import { createWorkspace, toApiError, type ApiError, type Template, type Workspace } from "./api";
import { ErrorMessage } from "./ErrorMessage";
import type { Loader } from "./hooks";
import { maxNameLength, validateWorkspaceName } from "../../src/shared/workspace-name.ts";

export function NewWorkspaceForm({
  templates,
  onCreated,
}: {
  templates: Loader<Template[]>;
  onCreated(workspace: Workspace): void;
}) {
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [chosenTemplate, setChosenTemplate] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const options = templates.state.status === "ready" ? templates.state.data : [];
  const template = chosenTemplate ?? options[0]?.id;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !template) return;
    const problem = validateWorkspaceName(name);
    setNameError(problem);
    setError(null);
    if (problem) {
      nameInput.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const workspace = await createWorkspace(name.trim(), template);
      setName("");
      onCreated(workspace);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  const hintId = `${id}-hint`;
  const nameErrorId = `${id}-name-error`;

  return (
    <section className="section card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>New Workspace</h2>
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <p id={hintId} className="hint">
            Up to {maxNameLength} characters.
          </p>
          <input
            ref={nameInput}
            id={`${id}-name`}
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${hintId} ${nameErrorId}` : hintId}
          />
          {nameError && (
            <p id={nameErrorId} className="field-error">
              {nameError}
            </p>
          )}
        </div>

        <fieldset className="field">
          <legend>Template</legend>
          {templates.state.status === "loading" && <p className="muted">Loading Templates…</p>}
          {templates.state.status === "failed" && (
            <ErrorMessage error={templates.state.error} retry={templates.retry} />
          )}
          {templates.state.status === "ready" && options.length === 0 && (
            <p className="muted">No Templates are available yet.</p>
          )}
          {options.map((option) => (
            <label key={option.id} className="choice">
              <input
                type="radio"
                name={`${id}-template`}
                value={option.id}
                checked={template === option.id}
                onChange={() => setChosenTemplate(option.id)}
              />
              <span>
                <span className="choice-name">{option.name}</span>
                <span className="choice-description">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {error && <ErrorMessage error={error} />}

        <div>
          <button type="submit" className="button button-primary" disabled={saving || !template}>
            {saving ? "Creating…" : "Create Workspace"}
          </button>
        </div>
      </form>
    </section>
  );
}
