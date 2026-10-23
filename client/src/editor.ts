import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import type { Problem } from "../../src/shared/check-report.ts";
import { problemPath } from "./problems";

/** The one editor on the Workspace page, showing one file at a time. */
export interface FileEditor {
  /** The open file's path, or null when none is open. */
  path(): string | null;
  /** Shows a file in place of the open one, with a fresh undo history. */
  open(path: string, text: string): void;
  /**
   * Shows the open file's text as it's now saved, such as after the Agent
   * changed it, keeping the cursor and scroll position where it can.
   * Returns whether the text changed.
   */
  replace(text: string): boolean;
  /** Stops or allows changes to the text, such as while the Agent is working. */
  setReadOnly(readOnly: boolean): void;
  /** Closes the open file, discarding any unsaved changes. */
  close(): void;
  /** The text to save, and the document it came from for `markSaved`. */
  snapshot(): { doc: Text; text: string };
  /** Records that `doc` was saved, so the file counts as changed only if it differs from `doc`. */
  markSaved(path: string, doc: Text): void;
  /** Whether the open file has changes that aren't saved. */
  isDirty(): boolean;
  /**
   * Takes a Check's problems, for the open file and the files opened later.
   * The open file shows them only if it has no unsaved changes; otherwise it
   * keeps the diagnostics it has, which move with the edits.
   */
  showProblems(problems: readonly Problem[]): void;
  /** Puts the cursor at a line and column, both from 1, scrolls to it and focuses the editor. */
  moveTo(line: number | null, column: number | null): void;
  destroy(): void;
}

/** Creates the editor inside `parent`. `onDirtyChange` hears whenever the open file gains or loses unsaved changes. */
export function createFileEditor(parent: HTMLElement, onDirtyChange: (dirty: boolean) => void): FileEditor {
  const language = new Compartment();
  const colourScheme = new Compartment();
  const lock = new Compartment();
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

  let path: string | null = null;
  let saved: Text;
  let dirty = false;
  let readOnly = false;
  let problems: readonly Problem[] = [];

  function updateDirty() {
    const next = path !== null && !view.state.doc.eq(saved);
    if (next === dirty) return;
    dirty = next;
    onDirtyChange(dirty);
  }

  function stateFor(filePath: string | null, text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        lintGutter(),
        syntaxHighlighting(highlightStyle),
        theme,
        language.of(filePath === null ? [] : languageFor(filePath)),
        colourScheme.of(EditorView.darkTheme.of(darkMode.matches)),
        lock.of(EditorState.readOnly.of(readOnly)),
        // Keep Windows line endings when they're the only kind. Mixed endings split on every
        // kind, as the Checker does, so line numbers agree, and save as \n.
        onlyCrlf(text) ? EditorState.lineSeparator.of("\r\n") : [],
        EditorView.contentAttributes.of({ "aria-label": filePath === null ? "Editor" : `Contents of ${filePath}` }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) updateDirty();
        }),
      ],
    });
  }

  function load(filePath: string | null, text: string) {
    path = filePath;
    view.setState(stateFor(filePath, text));
    saved = view.state.doc;
    updateDirty();
    applyProblems();
  }

  function applyProblems() {
    if (path === null || dirty) return;
    view.dispatch(setDiagnostics(view.state, toDiagnostics(problems, path, view.state.doc)));
  }

  const view = new EditorView({ parent, state: stateFor(null, "") });
  saved = view.state.doc;

  const onSchemeChange = () =>
    view.dispatch({ effects: colourScheme.reconfigure(EditorView.darkTheme.of(darkMode.matches)) });
  darkMode.addEventListener("change", onSchemeChange);

  return {
    path: () => path,
    open: (filePath, text) => load(filePath, text),
    replace(text) {
      if (path === null || text === view.state.sliceDoc()) return false;
      const { scrollTop } = view.scrollDOM;
      const cursor = view.state.selection.main.head;
      load(path, text);
      view.dispatch({ selection: EditorSelection.cursor(Math.min(cursor, view.state.doc.length)) });
      view.scrollDOM.scrollTop = scrollTop;
      return true;
    },
    setReadOnly(next) {
      if (next === readOnly) return;
      readOnly = next;
      view.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(readOnly)) });
    },
    close: () => load(null, ""),
    snapshot: () => ({ doc: view.state.doc, text: view.state.sliceDoc() }),
    markSaved(filePath, doc) {
      if (filePath !== path) return;
      saved = doc;
      updateDirty();
    },
    isDirty: () => dirty,
    showProblems(list) {
      problems = list;
      applyProblems();
    },
    moveTo(line, column) {
      const position = positionOf(view.state.doc, line, column);
      view.dispatch({
        selection: EditorSelection.cursor(position),
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
      view.focus();
    },
    destroy() {
      darkMode.removeEventListener("change", onSchemeChange);
      view.destroy();
    },
  };
}

/** The language a file is highlighted as, by its extension. Other files are plain text. */
export function languageFor(path: string): Extension {
  switch (/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "css":
      return css();
    case "html":
      return html();
    case "md":
      return markdown();
    default:
      return [];
  }
}

/** The document position of a line and column, both from 1, clamped to the document. */
export function positionOf(doc: Text, line: number | null, column: number | null): number {
  if (line === null) return 0;
  const { from, length } = doc.line(Math.min(Math.max(line, 1), doc.lines));
  return from + Math.min(Math.max((column ?? 1) - 1, 0), length);
}

/** Whether every line break in `text` is `\r\n`, and there's at least one. */
export const onlyCrlf = (text: string): boolean => text.includes("\r\n") && !/\r(?!\n)|(?<!\r)\n/.test(text);

const diagnosticSeverity = { error: "error", warning: "warning", suggestion: "hint", message: "info" } as const;

/** A file's problems as editor diagnostics. Problems with no file show in their tsconfig. */
export function toDiagnostics(problems: readonly Problem[], path: string, doc: Text): Diagnostic[] {
  return problems
    .filter((problem) => problemPath(problem) === path)
    .map((problem) => {
      const from = positionOf(doc, problem.line, problem.column);
      const to = problem.endLine === null ? from : Math.max(from, positionOf(doc, problem.endLine, problem.endColumn));
      return {
        from,
        to,
        severity: diagnosticSeverity[problem.severity],
        // Code 0 is a crash of the Checker itself, not a TypeScript error.
        source: problem.code === 0 ? undefined : `TS${problem.code}`,
        message: problem.message,
      };
    });
}

// Colours come from styles.css, so the editor follows the page's light and dark schemes.
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-keyword)" },
  { tag: [tags.string, tags.regexp], color: "var(--code-string)" },
  { tag: [tags.number, tags.bool, tags.atom, tags.unit, tags.color], color: "var(--code-literal)" },
  { tag: [tags.comment, tags.meta], color: "var(--code-comment)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--code-type)" },
  { tag: tags.function(tags.variableName), color: "var(--code-function)" },
  { tag: tags.function(tags.propertyName), color: "var(--code-function)" },
  { tag: tags.heading, fontWeight: "bold", color: "var(--code-keyword)" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { flex: "1 1 0", minHeight: "0", color: "var(--text)", backgroundColor: "var(--surface)", fontSize: "0.875rem" },
  // The editor's container shows the focus ring.
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--monospace)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": { color: "var(--muted)", backgroundColor: "var(--surface)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--code-active-line)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--code-selection)" },
});
