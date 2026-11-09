import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type { BuildReport } from "../../src/shared/build-report.ts";
import { getPreview, getPreviewLogs, getPreviewProblems, previewFrameLink, toApiError, type ApiError, type AppLogEntry } from "./api";
import type { PreviewProblems } from "../../src/shared/app-logs.ts";
import { useLoad, usePageVisible, type LoadState } from "./hooks";
import { forgetBuilds, noBuildsSeen, seeBuilds } from "./publish";

/** A sign-out this soon after the last one came straight after a fresh link, so the browser isn't keeping the cookie. */
const refusedWithinMs = 10_000;
const logsEveryMs = 3_000;
const problemsEveryMs = 5_000;

export interface PreviewFrame {
  /** Where the Preview answers, whether it has a Build to run yet, and that Build's hash. */
  info: LoadState<{ url: string; ready: boolean; hash: string | null }>;
  retryInfo(): void;
  /** Reads the Preview again quietly, to learn of Builds made elsewhere, as in another tab. */
  refreshInfo(): void;
  /** Forgets the Builds seen and the app shown, and reads the Preview afresh, after undoing the Turn that started the app removed it. */
  forget(): void;
  /** The hash of the latest successful Build this page has seen, which the Preview runs, or null before one. */
  goodHash: string | null;
  /** Whether a Build has succeeded, so the Preview has one to run. */
  built: boolean;
  /** The sign-in link the frame opens, or null while there's no frame. Each load gets a new one, as each works once. */
  src: string | null;
  frame: RefObject<HTMLIFrameElement | null>;
  /** Whether the frame is on its way to showing a new link. */
  loading: boolean;
  /** Why the last link couldn't be made. */
  error: ApiError | null;
  /** Whether the browser refused the Preview's cookie, so the frame can't stay signed in. */
  refused: boolean;
  /** Loads `path` in the frame with a fresh link, even after `refused`. */
  load(path: string): void;
  /** Call when the frame has loaded. */
  loaded(): void;
}

/**
 * The Preview pane's frame. It signs in with a fresh link each time it loads:
 * after each successful Build, on `load`, and when the Preview says the frame
 * has no session (ADR 0013). A hidden pane has no frame, so it runs no app
 * code, and gets a fresh link when it's shown again.
 */
export function usePreviewFrame(id: string, build: BuildReport | null, visible: boolean): PreviewFrame {
  // Successful Build reports seen, so a read of the Preview that started before one can't undo it.
  const goodReports = useRef(0);
  const info = useLoad(async () => {
    const before = goodReports.current;
    const preview = await getPreview(id);
    return { ...preview, overtaken: goodReports.current !== before };
  });
  const ready = info.state.status === "ready" && info.state.data.ready;
  const origin = info.state.status === "ready" ? new URL(info.state.data.url).origin : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const [path, setPath] = useState("/");
  const [loads, setLoads] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [refused, setRefused] = useState(false);
  const shownKey = useRef<string | null>(null);
  const signedOutAt = useRef(-Infinity);

  // The Preview runs the latest successful Build, so a failed one leaves the frame as it is.
  // It's whichever the page saw last: one of its Build reports, or the Build the Preview runs when the page reads it,
  // unless a successful Build report overtook that read.
  const previewRead = info.state.status === "ready" && !info.state.data.overtaken ? info.state.data : null;
  const [seen, setSeen] = useState(noBuildsSeen);
  const nowSeen = seeBuilds(seen, build, previewRead);
  if (nowSeen !== seen) setSeen(nowSeen);
  const { goodHash } = nowSeen;
  useEffect(() => {
    if (build?.ok) goodReports.current += 1;
  }, [build]);

  // The first successful Build starts the Preview.
  const onGoodBuild = useEffectEvent(() => {
    if (!ready) info.reload();
  });
  useEffect(() => {
    if (goodHash) onGoodBuild();
  }, [goodHash]);

  const key = `${goodHash} ${loads} ${path}`;
  useEffect(() => {
    if (!visible) {
      shownKey.current = null;
      setSrc(null);
      return;
    }
    if (!ready || refused || key === shownKey.current) return;
    let current = true;
    setLoading(true);
    previewFrameLink(id, path).then(
      (link) => {
        if (!current) return;
        shownKey.current = key;
        setSrc(link);
        setError(null);
      },
      (caught: unknown) => {
        if (!current) return;
        setError(toApiError(caught));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [id, visible, ready, refused, key, path]);

  const onSignedOut = useEffectEvent(() => {
    const now = Date.now();
    if (now - signedOutAt.current < refusedWithinMs) setRefused(true);
    else setLoads((count) => count + 1);
    signedOutAt.current = now;
  });
  // Without a session, as when its cookie expires, the Preview's page tells this one.
  useEffect(() => {
    if (!origin) return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (data && typeof data === "object" && "type" in data && data.type === "jigworks:preview-signed-out") onSignedOut();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [origin]);

  return {
    info: info.state,
    retryInfo: info.retry,
    refreshInfo: info.reload,
    forget() {
      setSeen(forgetBuilds(build, previewRead));
      shownKey.current = null;
      setSrc(null);
      // Not quietly, so the frame waits for the new read rather than showing the old app's.
      info.retry();
    },
    goodHash,
    built: ready || goodHash !== null,
    src,
    frame,
    loading,
    error,
    refused,
    load(next) {
      setPath(next);
      setLoads((count) => count + 1);
      setRefused(false);
    },
    loaded: () => setLoading(false),
  };
}

interface Polled<T> {
  /** The latest read, or null until the first has come back. */
  data: T | null;
  error: ApiError | null;
  refresh(): void;
}

/**
 * Reads `read` every `everyMs` while `active` and the page is showing, each
 * read after the last has come back. `read` reads Workspace `id`, which
 * starts the reads afresh when it changes.
 */
function usePolled<T>(id: string, read: () => Promise<T>, active: boolean, everyMs: number): Polled<T> {
  const pageVisible = usePageVisible();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const latestRead = useEffectEvent(read);

  useEffect(() => {
    if (!active || !pageVisible) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each read waits for the last, so a slow platform isn't sent a queue of them.
    const next = async () => {
      try {
        const latest = await latestRead();
        if (!current) return;
        setData(latest);
        setError(null);
      } catch (caught) {
        if (!current) return;
        const failure = toApiError(caught);
        setError(failure);
        // Reading again won't help until the Developer signs in again.
        if (failure.signedOut) return;
      }
      timer = setTimeout(next, everyMs);
    };
    void next();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, active, pageVisible, everyMs, refreshes]);

  return { data, error, refresh: () => setRefreshes((count) => count + 1) };
}

/** The Preview's logs, newest last, read every few seconds while `active` and the page is showing. */
export function usePreviewLogs(id: string, active: boolean): Polled<AppLogEntry[]> {
  return usePolled(id, () => getPreviewLogs(id), active, logsEveryMs);
}

/** The Preview's problems since its Build, for the note beside the app (#104), read every few seconds while `active` and the page is showing. */
export function usePreviewProblems(id: string, active: boolean): PreviewProblems | null {
  return usePolled(id, () => getPreviewProblems(id), active, problemsEveryMs).data;
}
