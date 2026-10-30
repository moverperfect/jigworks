import { useEffect, useId, useRef, useState } from "react";
import { getDeployment, publish, toApiError, type ApiError, type Deployment } from "./api";
import { ErrorMessage } from "./ErrorMessage";
import { useLoad } from "./hooks";
import { formatTime } from "./ProblemsPanel";

/**
 * The Workspace's Deployment in the page's header: when it was published,
 * a link to it, and Publish, which makes the Build the Preview runs the
 * Deployment. Replacing a Deployment asks first, as there's no going back.
 */
export function PublishControl({ id }: { id: string }) {
  const loaded = useLoad(() => getDeployment(id));
  const [publishing, setPublishing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const deployment = loaded.state.status === "ready" ? loaded.state.data : null;

  async function publishNow() {
    setConfirming(false);
    setPublishing(true);
    setError(null);
    try {
      const published = await publish(id);
      loaded.update(() => published);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="publish">
      {deployment?.publishedAt && (
        <span className="publish-status">
          Published {formatTime(deployment.publishedAt)} ·{" "}
          <a href={deployment.url} target="_blank" rel="noopener noreferrer">
            Open the Deployment
          </a>
        </span>
      )}
      <button
        type="button"
        className="button button-small"
        disabled={!deployment || publishing}
        onClick={() => (deployment?.publishedAt ? setConfirming(true) : void publishNow())}
      >
        {publishing ? "Publishing…" : "Publish"}
      </button>
      {loaded.state.status === "failed" && <ErrorMessage error={loaded.state.error} retry={loaded.retry} />}
      {error && <ErrorMessage error={error} />}
      {confirming && deployment && (
        <ReplaceDialog deployment={deployment} onConfirm={() => void publishNow()} onClose={() => setConfirming(false)} />
      )}
    </div>
  );
}

function ReplaceDialog({ deployment, onConfirm, onClose }: { deployment: Deployment; onConfirm(): void; onClose(): void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // StrictMode runs this twice in development, so don't open it twice.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={onClose}
    >
      <h2 id={`${id}-title`}>Replace the Deployment?</h2>
      <p id={`${id}-description`}>
        Everyone who opens {new URL(deployment.url).hostname} gets the Build the Preview runs now, in place of the one
        published {formatTime(deployment.publishedAt!)}. There's no going back to it.
      </p>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            dialog.current?.close();
            onConfirm();
          }}
        >
          Publish
        </button>
      </div>
    </dialog>
  );
}
