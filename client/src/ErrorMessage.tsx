import type { ApiError } from "./api";

/** Shows why a request failed. A signed-out Developer is asked to sign in again rather than retry. */
export function ErrorMessage({ error, retry }: { error: ApiError; retry?: () => void }) {
  if (error.signedOut) {
    return (
      <div className="message message-error" role="alert">
        <p>You're not signed in, or your sign-in has expired. Reload the page to sign in again.</p>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
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
