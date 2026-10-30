import { useState } from "react";
import { getDeployment, publish, toApiError, type ApiError, type Deployment } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorMessage } from "./ErrorMessage";
import { useLoad } from "./hooks";
import { formatTime } from "./ProblemsPanel";

/**
 * The Workspace's Deployment in the page's header: when it was published,
 * a link to it, and Publish, which copies the Build the Preview runs to the
 * Deployment. Replacing a Deployment asks first, as there's no going back.
 */
export function PublishControl({ id }: { id: string }) {
  const loaded = useLoad(() => getDeployment(id));
  const [busy, setBusy] = useState(false);
  // The Deployment the Developer is asked about replacing.
  const [replacing, setReplacing] = useState<Deployment | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const deployment = loaded.state.status === "ready" ? loaded.state.data : null;

  async function attempt(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(toApiError(caught));
      loaded.reload();
    } finally {
      setBusy(false);
    }
  }

  const publishOver = async (replaces: string | null) => {
    const published = await publish(id, replaces);
    loaded.update(() => published);
  };

  // Looks again first, as another tab may have published since this page loaded.
  const start = () =>
    attempt(async () => {
      const current = await getDeployment(id);
      loaded.update(() => current);
      if (current.hash) setReplacing(current);
      else await publishOver(null);
    });

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
      <button type="button" className="button button-small" disabled={!deployment || busy} onClick={() => void start()}>
        {busy ? "Publishing…" : "Publish"}
      </button>
      {loaded.state.status === "failed" && <ErrorMessage error={loaded.state.error} retry={loaded.retry} />}
      {error && <ErrorMessage error={error} />}
      {replacing && (
        <ConfirmDialog
          title="Replace the Deployment?"
          confirm="Publish"
          onClose={() => setReplacing(null)}
          onConfirm={() => void attempt(() => publishOver(replacing.hash))}
        >
          Everyone who opens {new URL(replacing.url).hostname} gets the Build the Preview runs now, in place of the one
          published {formatTime(replacing.publishedAt!)}. There's no going back to it.
        </ConfirmDialog>
      )}
    </div>
  );
}
