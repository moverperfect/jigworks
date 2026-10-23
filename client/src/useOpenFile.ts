import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Problem } from "../../src/shared/check-report.ts";
import { readFile, toApiError, writeFile, type ApiError } from "./api";
import { createFileEditor, type FileEditor } from "./editor";
import { setLeaveGuard } from "./router";

/** The file being shown in the editor, or on its way there. */
export type OpenedFile =
  | { path: string; status: "opening" | "open" }
  | { path: string; status: "failed"; error: ApiError };

/** Where to put the cursor in a file, with lines and columns from 1. */
export interface CursorTarget {
  line: number | null;
  column: number | null;
}

export interface OpenFile {
  /** Where the editor goes on the page. */
  editorHost: RefObject<HTMLDivElement | null>;
  opened: OpenedFile | null;
  /** Whether the open file has unsaved changes. */
  dirty: boolean;
  saving: boolean;
  /** Whether the open file was saved since it opened. */
  saved: boolean;
  saveError: ApiError | null;
  /** Opens a file once any save in progress is done, asking first if the open file has unsaved changes. */
  open(path: string, cursor?: CursorTarget): Promise<void>;
  save(): Promise<void>;
  /** Reads the open file again, such as after a Turn, unless it has unsaved changes. */
  reload(): Promise<void>;
}

/**
 * The file open in the editor: opening it, saving it with Save, Ctrl+S or
 * Cmd+S, and asking before unsaved changes are lost. A change to `problems`
 * goes to the editor's diagnostics, and `onSaved` hears of each save. While
 * `locked`, as during a Turn, the editor is read-only and Ctrl+S does nothing.
 */
export function useOpenFile(
  id: string,
  { problems, onSaved, locked }: { problems: readonly Problem[] | undefined; onSaved(): void; locked: boolean },
): OpenFile {
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<FileEditor | null>(null);
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const openRequest = useRef(0);
  // Saves run one after another, and opening a file waits for them.
  const saves = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const created = createFileEditor(editorHost.current!, setDirty);
    editor.current = created;
    return () => {
      created.destroy();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    if (problems) editor.current?.showProblems(problems);
  }, [problems]);

  useEffect(() => {
    editor.current?.setReadOnly(locked);
  }, [locked]);

  async function open(path: string, cursor?: CursorTarget) {
    const current = editor.current;
    if (!current) return;
    if (path === current.path()) {
      if (cursor) current.moveTo(cursor.line, cursor.column);
      return;
    }
    const request = ++openRequest.current;
    // A save in progress finishes first, so its outcome is shown with its own file.
    await saves.current;
    if (request !== openRequest.current || editor.current !== current) return;
    const openPath = current.path();
    if (openPath !== null && current.isDirty() && !confirm(`${openPath} has unsaved changes. Discard them and open ${path}?`)) {
      return;
    }

    current.close();
    setSaved(false);
    setSaveError(null);
    setOpened({ path, status: "opening" });
    try {
      const text = await readFile(id, path);
      if (request !== openRequest.current || editor.current !== current) return;
      current.open(path, text);
      // Show the editor before moving to the problem, so it can scroll and take focus.
      flushSync(() => setOpened({ path, status: "open" }));
      if (cursor) current.moveTo(cursor.line, cursor.column);
    } catch (caught) {
      if (request !== openRequest.current) return;
      setOpened({ path, status: "failed", error: toApiError(caught) });
    }
  }

  async function reload() {
    const current = editor.current;
    const path = current?.path() ?? null;
    if (!current || path === null || current.isDirty()) return;
    // Opening another file in the meantime wins.
    const request = openRequest.current;
    const stillOpen = () => request === openRequest.current && editor.current === current && current.path() === path;
    try {
      const text = await readFile(id, path);
      // Edits made while it loaded are kept.
      if (stillOpen() && !current.isDirty() && current.replace(text)) setSaved(false);
    } catch (caught) {
      if (!stillOpen()) return;
      // Such as the Agent having deleted it.
      current.close();
      setSaved(false);
      setOpened({ path, status: "failed", error: toApiError(caught) });
    }
  }

  function save(): Promise<void> {
    saves.current = saves.current.then(saveOnce);
    return saves.current;
  }

  async function saveOnce() {
    const current = editor.current;
    const path = current?.path() ?? null;
    if (!current || path === null || !current.isDirty()) return;
    const { doc, text } = current.snapshot();
    setSaving(true);
    try {
      await writeFile(id, path, text);
      current.markSaved(path, doc);
      setSaved(true);
      setSaveError(null);
      onSaved();
    } catch (caught) {
      setSaveError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S or Cmd+S saves from anywhere on the page, not only the editor.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    if (!locked) void save();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Ask before unsaved changes are lost by leaving the page.
  useEffect(() => {
    if (!dirty) return;
    const path = editor.current?.path();
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    const removeGuard = setLeaveGuard(() => confirm(`${path} has unsaved changes. Leave without saving them?`));
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      removeGuard();
    };
  }, [dirty]);

  return { editorHost, opened, dirty, saving, saved, saveError, open, save, reload };
}
