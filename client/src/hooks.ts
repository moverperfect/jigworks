import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, toApiError } from "./api";

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

export function useTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Jigworks` : "Jigworks";
  }, [title]);
}
