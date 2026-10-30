import { useSyncExternalStore, type ComponentProps, type MouseEvent } from "react";

export type Route = { page: "home" } | { page: "workspace"; id: string } | { page: "prototype" } | { page: "not-found" };

export function matchRoute(path: string): Route {
  if (path === "/") return { page: "home" };
  // PROTOTYPE, throwaway: the chat-first variants, on the dev server only.
  if (import.meta.env.DEV && path === "/prototype/chat-first") return { page: "prototype" };
  const match = /^\/workspaces\/([^/]+)\/?$/.exec(path);
  if (match) {
    try {
      return { page: "workspace", id: decodeURIComponent(match[1]!) };
    } catch {
      return { page: "not-found" };
    }
  }
  return { page: "not-found" };
}

export function workspacePath(id: string): string {
  return `/workspaces/${encodeURIComponent(id)}`;
}

/** Returns whether the Developer may leave the page, such as by asking whether to discard unsaved changes. */
type LeaveGuard = () => boolean;

let leaveGuard: LeaveGuard | null = null;
let shownPath = window.location.pathname;

/** Asks `guard` before leaving the page by a link or the browser's back and forward buttons. Returns a function that removes it. */
export function setLeaveGuard(guard: LeaveGuard): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

const mayLeave = () => leaveGuard === null || leaveGuard();

// Back and forward change the address before the page hears of it, so put the
// address back if the Developer stays. This listener is added before React's.
window.addEventListener("popstate", () => {
  if (window.location.pathname === shownPath) return;
  if (mayLeave()) shownPath = window.location.pathname;
  else window.history.pushState(null, "", shownPath);
});

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string): void {
  if (to !== window.location.pathname && !mayLeave()) return;
  window.history.pushState(null, "", to);
  shownPath = window.location.pathname;
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** A link that changes page without reloading, unless the Developer asks for a new tab or window. */
export function Link({ to, onClick, ...props }: { to: string } & Omit<ComponentProps<"a">, "href">) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  }
  return <a {...props} href={to} onClick={handleClick} />;
}
