import { lazy, Suspense, useEffect, useRef } from "react";
import { getMe } from "./api";
import { ErrorMessage } from "./ErrorMessage";
import { HomePage } from "./HomePage";
import { useLoad, useTitle } from "./hooks";
import { Link, matchRoute, usePath, type Route } from "./router";

// Loaded when first opened, so the home page doesn't wait for the editor.
const WorkspacePage = lazy(() => import("./WorkspacePage").then((module) => ({ default: module.WorkspacePage })));
// PROTOTYPE, throwaway: full-screen, without the platform's header or sign-in.
const ChatFirstPrototypePage = lazy(() =>
  import("./prototype/ChatFirstPrototypePage").then((module) => ({ default: module.ChatFirstPrototypePage })),
);

export function App() {
  const path = usePath();
  const route = matchRoute(path);
  if (route.page === "prototype") {
    return (
      <Suspense fallback={null}>
        <ChatFirstPrototypePage />
      </Suspense>
    );
  }
  return <PlatformApp path={path} route={route} />;
}

function PlatformApp({ path, route }: { path: string; route: Route }) {
  const me = useLoad(getMe);
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(path);

  // After a page change, start screen readers and the keyboard at the top of the new page.
  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    window.scrollTo(0, 0);
    main.current?.focus();
  }, [path]);

  const signedOut = me.state.status === "failed" && me.state.error.signedOut;
  let page;
  if (me.state.status === "failed" && me.state.error.signedOut) {
    page = (
      <>
        <h1>Sign in again</h1>
        <ErrorMessage error={me.state.error} />
      </>
    );
  } else if (route.page === "home") {
    page = <HomePage />;
  } else if (route.page === "workspace") {
    page = (
      <Suspense fallback={<p className="workspace-message muted">Loading the Workspace…</p>}>
        <WorkspacePage key={route.id} id={route.id} />
      </Suspense>
    );
  } else {
    page = <NotFound />;
  }

  return (
    <>
      <header className="site-header">
        <Link to="/" className="product-name">
          Jigworks
        </Link>
        <div className="account">
          {me.state.status === "loading" && <span className="muted">Loading your account…</span>}
          {me.state.status === "ready" && (
            <>
              <span className="muted">Signed in as </span>
              <span className="email">{me.state.data.email}</span>
            </>
          )}
          {me.state.status === "failed" && !me.state.error.signedOut && (
            <span>
              Couldn't load your account.{" "}
              <button type="button" className="link-button" onClick={me.retry}>
                Try again
              </button>
            </span>
          )}
        </div>
      </header>
      <main ref={main} tabIndex={-1} className={route.page === "workspace" && !signedOut ? "workspace-main" : undefined}>
        {page}
      </main>
    </>
  );
}

function NotFound() {
  useTitle("Page not found");
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to your Workspaces</Link>
      </p>
    </>
  );
}
