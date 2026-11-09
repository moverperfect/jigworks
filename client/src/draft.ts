/** The parts of the tab's session storage a draft uses. */
interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, text: string): void;
  removeItem(key: string): void;
}

/** A message box's text kept from before the page last reloaded, or "". `storage` is a function because reaching it can throw. */
export function readDraft(storage: () => DraftStorage, key: string): string {
  return tryStorage(() => storage().getItem(key)) ?? "";
}

/**
 * Keeps a message box's text from when the page goes until the box is back,
 * so that a reload, which is how the Developer signs in again (#111), doesn't
 * lose it. Returns a function that stops.
 */
export function keepDraft(page: EventTarget, storage: () => DraftStorage, key: string, text: () => string): () => void {
  const forget = () => tryStorage(() => storage().removeItem(key));
  const keep = () => {
    const kept = text();
    tryStorage(() => (kept ? storage().setItem(key, kept) : storage().removeItem(key)));
  };
  forget();
  page.addEventListener("pagehide", keep);
  // A page back from the back-forward cache still has its box, so the copy kept as it went must go,
  // or it would outlive the text being sent.
  page.addEventListener("pageshow", forget);
  return () => {
    page.removeEventListener("pagehide", keep);
    page.removeEventListener("pageshow", forget);
  };
}

/** Storage can be turned off, or full, and then the text is only lost as it was before. */
function tryStorage<T>(use: () => T): T | undefined {
  try {
    return use();
  } catch {
    return undefined;
  }
}
