import type { KeyboardEvent } from "react";

/** Whether a key in a message box sends: Enter does, Shift+Enter starts a new line, and Enter that picks an IME suggestion does neither. */
export function sendsMessage(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
}
