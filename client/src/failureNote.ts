import type { ApiError } from "./api";

/**
 * What the page shows where a request failed: why, or, for an expired
 * sign-in, nothing, because the page's own note above everything asks the
 * Developer to sign in again. A modal dialog hides that note, so in one the
 * failure asks again itself.
 */
export function failureNote(error: ApiError, inDialog: boolean): "message" | "sign-in" | null {
  if (!error.signedOut) return "message";
  return inDialog ? "sign-in" : null;
}
