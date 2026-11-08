import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getMe } from "./api";
import { ErrorMessage } from "./ErrorMessage";
import { useLoad, useTitle, type Loader } from "./hooks";
import { Menu } from "./Menu";
import { Link, matchRoute, usePath } from "./router";
import { StartPage } from "./StartPage";

// Loaded when first opened, so the home page doesn't wait for the editor.
const WorkspacePage = lazy(() => import("./WorkspacePage").then((module) => ({ default: module.WorkspacePage })));

export function App() {
  const path = usePath();
  const route = matchRoute(path);
  const me = useLoad(getMe);
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(path);
  // The bar along the top. The Workspace page fills it with the Workspace's name, Publish and its own menu.
  const [bar, setBar] = useState<HTMLElement | null>(null);

  const signedOut = me.state.status === "failed" && me.state.error.signedOut;
  const account = <Account me={me} />;
  const workspacePage = route.page === "workspace" && !signedOut;

  // After a page change, start screen readers and the keyboard at the top of the new page.
  // The Workspace page's heading, the Workspace's name, is in the bar.
  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    window.scrollTo(0, 0);
    (workspacePage ? bar : main.current)?.focus();
  }, [path]);

  let page;
  if (me.state.status === "failed" && me.state.error.signedOut) {
    page = (
      <>
        <h1>Sign in again</h1>
        <ErrorMessage error={me.state.error} />
      </>
    );
  } else if (route.page === "home") {
    page = <StartPage />;
  } else if (route.page === "workspace") {
    page = (
      <Suspense fallback={<p className="workspace-message muted">Loading your app…</p>}>
        <WorkspacePage key={route.id} id={route.id} bar={bar} account={account} />
      </Suspense>
    );
  } else {
    page = <NotFound />;
  }

  return (
    <>
      <header ref={setBar} tabIndex={-1} className="site-header">
        <Link to="/" className="product-name">
          Jigworks
        </Link>
        {!workspacePage && !signedOut && <Menu account={account} />}
      </header>
      <main ref={main} tabIndex={-1} className={workspacePage ? "workspace-main" : undefined}>
        {page}
      </main>
    </>
  );
}

/** Who's signed in, at the top of the bar's menu. */
function Account({ me }: { me: Loader<{ email: string }> }) {
  const { state } = me;
  if (state.status === "loading") return <span className="muted">Loading your account…</span>;
  if (state.status === "ready") {
    return (
      <>
        <span className="muted">Signed in as </span>
        <span className="email">{state.data.email}</span>
      </>
    );
  }
  return (
    <>
      Couldn't load your account.{" "}
      <button type="button" className="link-button" onClick={me.retry}>
        Try again
      </button>
    </>
  );
}

function NotFound() {
  useTitle("Page not found");
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to your apps</Link>
      </p>
    </>
  );
}
