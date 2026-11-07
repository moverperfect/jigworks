import { useEffect, useState } from "react";
import { getDeployment, publish, toApiError, type ApiError, type Deployment } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorMessage } from "./ErrorMessage";
import type { Loader } from "./hooks";
import { formatTime } from "./ProblemsPanel";
import { firstPublishNote, publishState } from "./publish";

/**
 * Publishing, in the page's header and its words (ADR 0018): whether the app
 * is live, its address and "Copy the link" once it is, and Publish, which
 * copies the Build the Preview runs to the Deployment. Publishing always asks
 * first: the first time, as it lets anyone with the link use the app; after
 * that, as the published version can't be brought back.
 */
export function PublishControl({
  id,
  name,
  deployment: loaded,
  latestGoodHash,
  locked,
}: {
  id: string;
  /** The app's name, for the first Publish's question. */
  name: string;
  deployment: Loader<Deployment>;
  /** The latest successful Build's hash, as `publishState` takes it. */
  latestGoodHash: string | null;
  /** Whether a Turn is running, when publishing is refused. */
  locked: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // The Deployment the Developer is asked about publishing over.
  const [asking, setAsking] = useState<Deployment | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const deployment = loaded.state.status === "ready" ? loaded.state.data : null;
  const state = deployment && publishState(deployment.hash, latestGoodHash);

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

  // Looks again first, as another tab may have published since this page loaded.
  const start = () =>
    attempt(async () => {
      const current = await getDeployment(id);
      loaded.update(() => current);
      if (publishState(current.hash, latestGoodHash) !== "live") setAsking(current);
    });

  // Publishes over the Deployment the Developer was asked about, which the platform refuses if it has changed since.
  const publishOver = (over: Deployment) =>
    attempt(async () => {
      const published = await publish(id, over.hash);
      loaded.update(() => published);
    });

  const host = deployment && new URL(deployment.url).hostname;
  const address = deployment && (
    <a href={deployment.url} target="_blank" rel="noopener noreferrer">
      {host}
    </a>
  );
  const first = asking?.hash === null;

  return (
    <>
      <div className="publish">
        {state && (
          <span className="publish-status">
            {state === "not-published" && "Not published"}
            {state === "live" && <>Live at {address}</>}
            {state === "live-with-changes" && <>Live at {address}, with changes not yet published</>}
          </span>
        )}
        {deployment?.hash && <CopyLink url={deployment.url} />}
        <button
          type="button"
          className="button button-primary button-small"
          // Before the first successful Build, or live with nothing new, there's nothing to publish.
          disabled={state === null || latestGoodHash === null || state === "live" || locked || busy}
          onClick={() => void start()}
        >
          {busy ? "Publishing…" : state === "live-with-changes" ? "Publish changes" : "Publish"}
        </button>
      </div>
      {(loaded.state.status === "failed" || error) && (
        <div className="workspace-header-message">
          {loaded.state.status === "failed" && <ErrorMessage error={loaded.state.error} retry={loaded.retry} />}
          {error && <ErrorMessage error={error} />}
        </div>
      )}
      {asking && (
        <ConfirmDialog
          title={first ? `Publish ${name}?` : "Publish your changes?"}
          confirm={first ? "Publish" : "Publish changes"}
          cancel="Not yet"
          onClose={() => setAsking(null)}
          onConfirm={() => void publishOver(asking)}
        >
          {first ? (
            <>
              {firstPublishNote(asking.openToEveryone, new URL(asking.url).hostname)} You can keep changing it here, and people get your
              changes only when you publish them.
            </>
          ) : (
            <>
              People with the link will get the latest version of your app, in place of the one published{" "}
              {formatTime(asking.publishedAt!)}. That one can't be brought back.
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

/** Copies the app's address, and says whether it could. */
function CopyLink({ url }: { url: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 3000);
    return () => clearTimeout(timer);
  }, [result]);

  function copy() {
    // The clipboard is missing outside secure pages, which throws before the promise.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => setResult("copied"),
        () => setResult("failed"),
      );
  }

  return (
    <>
      <button type="button" className="button button-small" onClick={copy}>
        Copy the link
      </button>
      <span className="publish-copied" role="status">
        {result === "copied" && "Copied"}
        {result === "failed" && "Couldn't copy it. Copy the address instead."}
      </span>
    </>
  );
}
