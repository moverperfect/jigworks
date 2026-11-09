import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poll } from "./live";

/** A stand-in for the page's document, which tests don't have: shown until `hide`. */
function fakePage() {
  const page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", page);
  const set = (hidden: boolean) => {
    page.hidden = hidden;
    page.dispatchEvent(new Event("visibilitychange"));
  };
  return { hide: () => set(true), show: () => set(false) };
}

/**
 * Replaces `fetch` with a route that answers `data` as JSON, as a route with
 * Hono's etag() does: with an ETag, and 304 without a body when the request's
 * If-None-Match has it. Without `etags`, it sends no ETag, and always 200.
 */
function fakeRoute(data: unknown, { etags = true } = {}) {
  /** What the route answers, and when each ask came, in fake milliseconds. */
  const route = { data, times: [] as number[] };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    route.times.push(Date.now());
    const body = JSON.stringify(route.data);
    const etag = `"${body.length}-${encodeURIComponent(body)}"`;
    if (!etags) return new Response(body);
    if (new Headers(init?.headers).get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(body, { headers: { ETag: etag } });
  });
  return Object.assign(route, { fetch });
}

/** The gaps between each ask and the one before it. */
const gaps = (times: number[]) => times.slice(1).map((time, i) => time - times[i]!);

describe("asking for changes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks at once, and then passes on only answers that changed, which another ask brings", async () => {
    fakePage();
    const route = fakeRoute(["Ada"]);
    const onChange = vi.fn();
    poll("/api/signups", onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Ada"]);
    expect(route.fetch).toHaveBeenCalledWith("/api/signups", expect.objectContaining({ cache: "no-store" }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(route.times).toHaveLength(2);
    // It sent the ETag, and the route answered 304.
    expect(new Headers(route.fetch.mock.calls[1]![1]?.headers).get("If-None-Match")).toMatch(/^"/);
    expect(onChange).toHaveBeenCalledOnce();

    route.data = ["Ada", "Grace"];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onChange).toHaveBeenLastCalledWith(["Ada", "Grace"]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("asks more slowly while nothing changes, up to every 30 seconds, and every 5 again after a change", async () => {
    fakePage();
    const route = fakeRoute([]);
    poll("/api/signups", () => {});
    await vi.advanceTimersByTimeAsync(170_000);
    expect(gaps(route.times)).toEqual([5_000, 7_500, 11_250, 16_875, 25_313, 30_000, 30_000, 30_000]);

    route.data = ["Ada"];
    const changedAt = route.times.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(gaps(route.times.slice(changedAt))).toEqual([5_000, 7_500, 11_250]);
  });

  it("asks at the pace it's given", async () => {
    fakePage();
    const route = fakeRoute([]);
    poll("/api/votes", () => {}, { every: 2_000, slowest: 3_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gaps(route.times)).toEqual([2_000, 3_000, 3_000]);
  });

  it("doesn't ask while the page is hidden, and asks at once when it's shown, then at the first pace", async () => {
    const page = fakePage();
    const route = fakeRoute([]);
    poll("/api/signups", () => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(route.times).toHaveLength(3);

    page.hide();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(route.times).toHaveLength(3);

    page.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(route.times).toHaveLength(4);
    // Nothing had changed, so a little slower than the first pace.
    await vi.advanceTimersByTimeAsync(7_500);
    expect(route.times).toHaveLength(5);
  });

  it("asks afresh when the page is shown while an ask is still waiting, even one that never answers", async () => {
    const page = fakePage();
    const onChange = vi.fn();
    // The first ask never answers, until it's given up on.
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    );
    fakeRoute(["Ada"]);
    poll("/api/signups", onChange);
    page.hide();
    page.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Ada"]);
  });

  it("drops an answer to an ask that was replaced, even one that arrives despite the abort", async () => {
    const page = fakePage();
    const onChange = vi.fn();
    let answerLate: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise((resolve) => (answerLate = resolve)));
    fakeRoute(["new"]);
    poll("/api/signups", onChange);
    page.hide();
    page.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["new"]);

    answerLate(Response.json(["old"], { headers: { ETag: '"old"' } }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("doesn't start asking on a hidden page until it's shown", async () => {
    const page = fakePage();
    page.hide();
    const route = fakeRoute(["Ada"]);
    const onChange = vi.fn();
    poll("/api/signups", onChange);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(route.times).toEqual([]);

    page.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledWith(["Ada"]);
  });

  it("passes on nothing from a route that fails or can't be reached, and keeps asking, more slowly", async () => {
    fakePage();
    const onChange = vi.fn();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response("Oops", { status: 500 }));
    poll("/api/signups", onChange);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    fakeRoute(["Ada"]);
    await vi.advanceTimersByTimeAsync(11_250);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Ada"]);
  });

  it("passes on an answer only when it changed, from a route without an ETag too", async () => {
    fakePage();
    const route = fakeRoute(["Ada"], { etags: false });
    const onChange = vi.fn();
    poll("/api/signups", onChange);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(route.times).toHaveLength(3);
    expect(onChange).toHaveBeenCalledOnce();

    route.data = ["Ada", "Grace"];
    await vi.advanceTimersByTimeAsync(11_250);
    expect(onChange).toHaveBeenLastCalledWith(["Ada", "Grace"]);
  });

  it("stops asking when told, and stops listening to the page", async () => {
    const page = fakePage();
    const route = fakeRoute(["Ada"]);
    const onChange = vi.fn();
    const stop = poll("/api/signups", onChange);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    page.hide();
    page.show();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(route.times).toHaveLength(1);
  });

  it("drops an answer that arrives after it was stopped", async () => {
    fakePage();
    const onChange = vi.fn();
    let answer: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      init?.signal?.addEventListener("abort", () => answer(Response.json(["late"])));
      return new Promise((resolve) => (answer = resolve));
    });
    const stop = poll("/api/signups", onChange);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
