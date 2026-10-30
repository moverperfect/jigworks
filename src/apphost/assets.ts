import type { AssetSettings, Build } from "../builder";

export type AppAssets = Pick<Build, "assets" | "assetManifest" | "assetSettings">;

const noSettings: AssetSettings = { notFoundHandling: "none", runWorkerFirst: false };

/**
 * The Build's asset that answers `request`, routed as Cloudflare routes
 * assets, or null when the Worker should answer:
 * - paths `runWorkerFirst` covers go to the Worker;
 * - a path that matches an asset gets it, `/notes` matching `/notes.html` or
 *   `/notes/index.html` too;
 * - with `single-page-application`, any other page navigation gets `/index.html`.
 */
export function assetResponse(request: Request, build: Partial<AppAssets>): Response | null {
  const { assets = {}, assetManifest = {}, assetSettings = noSettings } = build;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  if (runsWorkerFirst(pathname, assetSettings.runWorkerFirst)) return null;
  const tried = pathname.endsWith("/") ? [`${pathname}index.html`] : [pathname, `${pathname}.html`, `${pathname}/index.html`];
  let path = tried.find((candidate) => candidate in assets);
  const navigation = request.headers.get("Sec-Fetch-Mode") === "navigate";
  if (!path && navigation && assetSettings.notFoundHandling === "single-page-application" && "/index.html" in assets) {
    path = "/index.html";
  }
  if (!path) return null;

  const { contentType = "application/octet-stream", etag: hash } = assetManifest[path] ?? {};
  // A Build's assets change with every Build, so the browser asks each time.
  const headers = new Headers({ "Content-Type": contentType, "Cache-Control": "no-cache" });
  if (hash) {
    const etag = `"${hash}"`;
    headers.set("ETag", etag);
    // Compared weakly, as If-None-Match is (RFC 9110).
    const tags = request.headers.get("If-None-Match")?.split(",").map((tag) => tag.trim().replace(/^W\//, ""));
    if (tags?.includes(etag)) return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : assets[path], { headers });
}

/** Whether `runWorkerFirst` covers a path: true, or a pattern such as `/api/*` that matches and no `!` pattern that does. */
function runsWorkerFirst(pathname: string, rule: AssetSettings["runWorkerFirst"]): boolean {
  if (typeof rule === "boolean") return rule;
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(pathname);
  return (
    rule.some((pattern) => !pattern.startsWith("!") && matches(pattern)) &&
    !rule.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1)))
  );
}
