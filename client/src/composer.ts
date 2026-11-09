import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { keepDraft, readDraft } from "./draft";

/** Whether a key in a message box sends: Enter does, Shift+Enter starts a new line, and Enter that picks an IME suggestion does neither. */
export function sendsMessage(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
}

/** A message box's text, kept across a reload of the page (see `keepDraft`). */
export function useDraft(key: string): [string, (text: string) => void] {
  const [text, setText] = useState(() => readDraft(() => sessionStorage, key));
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => keepDraft(window, () => sessionStorage, key, () => latest.current), [key]);
  return [text, setText];
}
