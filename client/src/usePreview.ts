import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type { BuildReport } from "../../src/shared/build-report.ts";
import { getPreview, getPreviewLogs, previewFrameLink, toApiError, type ApiError, type AppLogEntry } from "./api";
import { useLoad, usePageVisible, type LoadState } from "./hooks";

/** A sign-out this soon after the last one came straight after a fresh link, so the browser isn't keeping the cookie. */
const refusedWithinMs = 10_000;
const logsEveryMs = 3_000;

export interface PreviewFrame {
  /** Where the Preview answers, and whether it has a Build to run yet. */
  info: LoadState<{ url: string; ready: boolean }>;
  retryInfo(): void;
  /** The sign-in link the frame opens, or null before the first. Each load gets a new one, as each works once. */
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
 * has no session (ADR 0013). Links are made only while `visible`, so a hidden
 * pane runs no app code, and catches up when it's shown.
 */
export function usePreviewFrame(id: string, build: BuildReport | null, visible: boolean): PreviewFrame {
  const info = useLoad(() => getPreview(id));
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
  const [goodHash, setGoodHash] = useState<string | null>(null);
  if (build?.ok && build.hash !== goodHash) setGoodHash(build.hash);

  // The first successful Build starts the Preview.
  const onGoodBuild = useEffectEvent(() => {
    if (!ready) info.reload();
  });
  useEffect(() => {
    if (goodHash) onGoodBuild();
  }, [goodHash]);

  const key = `${goodHash} ${loads} ${path}`;
  useEffect(() => {
    if (!visible || !ready || refused || key === shownKey.current) return;
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

export interface PreviewLogs {
  /** The newest lines, oldest first, or null until they've loaded. */
  logs: AppLogEntry[] | null;
  error: ApiError | null;
  refresh(): void;
}

/** The Preview's logs, read every few seconds while `active` and the page is showing. */
export function usePreviewLogs(id: string, active: boolean): PreviewLogs {
  const pageVisible = usePageVisible();
  const [logs, setLogs] = useState<AppLogEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    if (!active || !pageVisible) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each read waits for the last, so a slow platform isn't sent a queue of them.
    const read = async () => {
      try {
        const latest = await getPreviewLogs(id);
        if (!current) return;
        setLogs(latest);
        setError(null);
      } catch (caught) {
        if (!current) return;
        const failure = toApiError(caught);
        setError(failure);
        // Reading again won't help until the Developer signs in again.
        if (failure.signedOut) return;
      }
      timer = setTimeout(read, logsEveryMs);
    };
    void read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, active, pageVisible, refreshes]);

  return { logs, error, refresh: () => setRefreshes((count) => count + 1) };
}
