import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, isSignedOut, onSignedOutChange, toApiError } from "./api";

export type LoadState<T> = { status: "loading" } | { status: "failed"; error: ApiError } | { status: "ready"; data: T };

export interface Loader<T> {
  state: LoadState<T>;
  retry(): void;
  /** Loads again, keeping the data on show until the new data arrives. */
  reload(): void;
  /** Changes the loaded data in place, such as after creating or deleting something. */
  update(change: (data: T) => T): void;
}

/** Runs `load` once on mount, and again on `retry` or `reload`. */
export function useLoad<T>(load: () => Promise<T>): Loader<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState({ count: 0, quietly: false });
  const latestLoad = useRef(load);
  latestLoad.current = load;

  useEffect(() => {
    let current = true;
    if (!attempt.quietly) setState({ status: "loading" });
    latestLoad.current().then(
      (data) => current && setState({ status: "ready", data }),
      (error: unknown) => current && setState({ status: "failed", error: toApiError(error) }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  return {
    state,
    retry: () => setAttempt(({ count }) => ({ count: count + 1, quietly: false })),
    reload: () => setAttempt(({ count }) => ({ count: count + 1, quietly: true })),
    update: (change) => setState((s) => (s.status === "ready" ? { status: "ready", data: change(s.data) } : s)),
  };
}

const onVisibilityChange = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};

/** Whether the page is showing, rather than in a background tab or a minimised window. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(onVisibilityChange, () => document.visibilityState === "visible");
}

/** Whether a request has found the Developer's sign-in expired, which only reloading the page clears. */
export function useSignedOut(): boolean {
  return useSyncExternalStore(onSignedOutChange, isSignedOut);
}

export function useTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Jigworks` : "Jigworks";
  }, [title]);
}

/** Whether the window matches a media query, such as `(width < 760px)`, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
