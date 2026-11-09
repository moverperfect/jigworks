import type { ApiError } from "./api";
import { failureNote } from "./failureNote";

/** Shows why a request failed (see `failureNote`). `inDialog` says it's in a modal dialog. */
export function ErrorMessage({ error, retry, inDialog = false }: { error: ApiError; retry?: () => void; inDialog?: boolean }) {
  const note = failureNote(error, inDialog);
  if (note === "sign-in") return <SignedOutNote />;
  if (note === null) return null;
  return (
    <div className="message message-error" role="alert">
      <p>{error.message}</p>
      {retry && (
        <button type="button" className="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Says the Developer's sign-in has expired. Reloading signs them in again:
 * Access sends the page to its login, then back to the same address.
 */
export function SignedOutNote() {
  return (
    <div className="message message-error" role="alert">
      <p>You've been signed out. Sign in again to carry on.</p>
      <button type="button" className="button" onClick={() => window.location.reload()}>
        Sign in again
      </button>
    </div>
  );
}
