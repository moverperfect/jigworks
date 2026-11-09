/** How often `poll` asks, in milliseconds. */
export interface PollOptions {
  /** How long it waits between asks while things are changing: 5 seconds unless given. */
  every?: number;
  /** The longest it waits once nothing has changed for a while: 30 seconds unless given. */
  slowest?: number;
}

/** How much longer `poll` waits after each answer that hasn't changed. */
const slowing = 1.5;

/**
 * Asks `url`, one of the app's GET routes, for what it answers, at once and
 * then every few seconds while the page is shown, and calls `onChange` with
 * the answer, parsed from JSON, whenever it differs from the last.
 *
 * It waits longer after each answer that hasn't changed, up to `slowest`, and
 * goes back to `every` after one that has. While the page is hidden it doesn't
 * ask, and when it's shown again it asks at once, in place of any ask still
 * waiting for its answer. An answer that isn't OK, or none at all, counts as
 * unchanged.
 *
 * Returns a function that stops it, so it starts in one line in React:
 * `useEffect(() => poll("/api/signups", setSignups), []);`
 */
export function poll<T>(url: string, onChange: (data: T) => void, { every = 5_000, slowest = 30_000 }: PollOptions = {}): () => void {
  let etag: string | null = null;
  let lastBody: string | null = null;
  let wait = every;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The ask waiting for its answer, if any: a newer one, or stopping, aborts it, and its answer is dropped. */
  let inFlight: AbortController | null = null;

  const ask = async () => {
    clearTimeout(timer);
    if (document.hidden) return;
    inFlight?.abort();
    const thisAsk = (inFlight = new AbortController());
    let answer: { body: string; etag: string | null } | null = null;
    try {
      // The route's ETag (Hono's etag()) lets it answer 304, without its body, when nothing has changed.
      const response = await fetch(url, { cache: "no-store", headers: etag ? { "If-None-Match": etag } : {}, signal: thisAsk.signal });
      if (response.status === 200) answer = { body: await response.text(), etag: response.headers.get("ETag") };
    } catch {
      // Out of reach, or aborted: asked again later, as if unchanged.
    }
    if (inFlight !== thisAsk) return;
    inFlight = null;
    let changed: { data: T } | null = null;
    if (answer) {
      try {
        if (answer.body !== lastBody) changed = { data: JSON.parse(answer.body) as T };
        ({ body: lastBody, etag } = answer);
      } catch {
        // Not JSON: as if unchanged.
      }
    }
    wait = changed ? every : Math.min(Math.round(wait * slowing), slowest);
    timer = setTimeout(ask, wait);
    // After the next ask is set, so an error in onChange doesn't stop the asking.
    if (changed) onChange(changed.data);
  };

  const shownOrHidden = () => {
    if (document.hidden) {
      clearTimeout(timer);
    } else {
      wait = every;
      void ask();
    }
  };

  document.addEventListener("visibilitychange", shownOrHidden);
  void ask();
  return () => {
    clearTimeout(timer);
    inFlight?.abort();
    inFlight = null;
    document.removeEventListener("visibilitychange", shownOrHidden);
  };
}
