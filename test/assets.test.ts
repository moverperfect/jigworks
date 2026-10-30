import { describe, expect, it } from "vitest";
import { assetResponse, type AppAssets } from "../src/apphost/assets";
import type { AssetSettings } from "../src/builder";

// How the app host routes a request to a Build's assets or its Worker
// (ADR 0014). test/preview.test.ts covers the same through a Preview.

const build: AppAssets = {
  assets: {
    "/index.html": "<p>app</p>",
    "/styles.css": "p{}",
    "/about.html": "<p>about</p>",
    "/docs/index.html": "<p>docs</p>",
    "/api/docs.json": "{}",
  },
  assetManifest: {
    "/index.html": { contentType: "text/html", etag: "a1" },
    "/styles.css": { contentType: "text/css", etag: "b2" },
    "/about.html": { contentType: "text/html", etag: "c3" },
    "/docs/index.html": { contentType: "text/html", etag: "d4" },
    "/api/docs.json": { contentType: "application/json", etag: "e5" },
  },
  assetSettings: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*", "!/api/docs.json"] },
};

const get = (path: string, headers: Record<string, string> = {}, assetSettings?: AssetSettings, method = "GET") =>
  assetResponse(new Request(`https://notes-k3x9p2qa-preview.example${path}`, { method, headers }), {
    ...build,
    ...(assetSettings && { assetSettings }),
  });
const navigate = { "Sec-Fetch-Mode": "navigate" };
const plain: AssetSettings = { notFoundHandling: "none", runWorkerFirst: false };

describe("the app host's asset routing", () => {
  it("serves an asset at its path, and a page at its path without .html or with a slash", async () => {
    const styles = get("/styles.css");
    expect(styles?.headers.get("Content-Type")).toBe("text/css");
    expect(await styles?.text()).toBe("p{}");
    expect(await get("/")?.text()).toBe("<p>app</p>");
    expect(await get("/about")?.text()).toBe("<p>about</p>");
    expect(await get("/docs")?.text()).toBe("<p>docs</p>");
    expect(await get("/docs/")?.text()).toBe("<p>docs</p>");
  });

  it("gives a page navigation with no asset index.html, only with single-page-application", async () => {
    expect(await get("/notes/42", navigate)?.text()).toBe("<p>app</p>");
    expect(get("/notes/42")).toBeNull();
    expect(get("/notes/42", navigate, plain)).toBeNull();
  });

  it("leaves the paths run_worker_first covers to the Worker, unless a ! pattern excludes them", async () => {
    expect(get("/api/hello", navigate)).toBeNull();
    expect(await get("/api/docs.json")?.text()).toBe("{}");
    expect(get("/styles.css", {}, { ...plain, runWorkerFirst: true })).toBeNull();
  });

  it("sends a quoted ETag, and answers a matching If-None-Match with 304", () => {
    expect(get("/styles.css")?.headers.get("ETag")).toBe('"b2"');
    expect(get("/styles.css")?.headers.get("Cache-Control")).toBe("no-cache");
    for (const sent of ['"b2"', 'W/"b2"', '"other", "b2"']) {
      expect(get("/styles.css", { "If-None-Match": sent })?.status).toBe(304);
    }
    expect(get("/styles.css", { "If-None-Match": '"other"' })?.status).toBe(200);
  });

  it("answers HEAD with no body, and leaves other methods to the Worker", () => {
    const head = get("/styles.css", {}, undefined, "HEAD");
    expect(head?.status).toBe(200);
    expect(head?.body).toBeNull();
    expect(get("/styles.css", {}, undefined, "POST")).toBeNull();
  });
});
