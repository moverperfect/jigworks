import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Build } from "../builder";
import { assetResponse, type AppAssets } from "./assets";
import type { AppLogEntry, Slot } from "../shared/app-logs";

export type { AppLogEntry, Slot };

/** Where a Preview sign-in link opens: the Preview pane's frame, or a tab of its own. */
export type SignInDestination = "iframe" | "document";

/** A request the Agent sends the Preview. */
export interface PreviewRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** What came back from a request the Agent sent the Preview. */
export interface PreviewExchange {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Whether the body was cut short. */
  truncated: boolean;
}

const runnableFields = [
  "hash",
  "mainModule",
  "modules",
  "compatibilityDate",
  "compatibilityFlags",
  "vars",
  "assets",
  "assetManifest",
  "assetSettings",
] as const;

/** The part of a Build that runs, which the Workspace gives its app host. */
export type RunnableBuild = Pick<Build, (typeof runnableFields)[number]>;

/** A Build's runnable part, without its report. */
export function runnable(build: Build): RunnableBuild {
  return Object.fromEntries(runnableFields.map((field) => [field, build[field]])) as RunnableBuild;
}

/** A Build as the app host keeps it. Builds kept before ticket 09 have no assets. */
type KeptBuild = Omit<RunnableBuild, keyof AppAssets> & Partial<AppAssets>;

// Limits on app code, so a runaway app can't burn through the account's
// quota. Outbound requests are otherwise unrestricted (ticket 08).
const appLimits = { cpuMs: 10_000, subRequests: 50 };
// Used when an app's wrangler.jsonc has no compatibility date.
const fallbackCompatibilityDate = "2026-10-01";
const logsKept = 500;
const logLineLength = 2_000;
const previewBodyShown = 20_000;
// SQLite's rows hold at most 2 MB; a UTF-8 character takes up to 3 bytes.
const chunkCharacters = 500_000;
// The paths the app host keeps for itself on a Preview. App code never sees them.
const reservedPaths = "/__jigworks/";
export const browserErrorsPath = `${reservedPaths}errors`;
export const signInPath = `${reservedPaths}sign-in`;
// The Preview's own session cookie (ADR 0013), which app code never sees or sets.
export const sessionCookie = "__Host-jigworks-preview";
const signInSeconds = 60;
const sessionSeconds = 8 * 60 * 60;
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const notReady = "The Preview starts after the Workspace's first successful Build.";
// How long the Agent's request to the Preview waits for its response, all of it.
const previewWaitSeconds = 10;

/**
 * One per app, named by its label (`<slug>-<random>`): the Workspace's
 * Preview and, from ticket 10, its Deployment (ADR 0009). It keeps the Build
 * each one runs, runs it on a Dynamic Worker, and keeps their logs.
 *
 * Access lets Preview hostnames through (ADR 0013), so the app host is the
 * Preview's gate: it opens the Preview only with a session from one of its
 * own single-use sign-in links, which the platform mints for the Workspace's
 * Developer. The platform Worker checks Access for the Deployment.
 */
export class AppHost extends DurableObject<Env> {
  private loaded: KeptBuild | null = null;
  private tablesReady = false;

  /** The Workspace this app belongs to, or null before it has one. */
  workspaceId(): string | null {
    return this.ctx.storage.kv.get<string>("workspace") ?? null;
  }

  /**
   * Takes a Workspace's latest successful Build as the Preview. A label
   * belongs to one Workspace for as long as it lasts, so another Workspace's
   * Build is refused: its Workspace then picks a new label.
   */
  receiveBuild(workspaceId: string, label: string, build: RunnableBuild): { accepted: boolean } {
    if (!this.claim(workspaceId, label)) return { accepted: false };
    const kv = this.ctx.storage.kv;
    const previous = kv.get<string>("preview");
    if (previous === build.hash) return { accepted: true };
    const text = JSON.stringify(build);
    this.ctx.storage.transactionSync(() => {
      if (previous) this.sql().exec("DELETE FROM build_chunks WHERE hash = ?", previous);
      for (let part = 0; part * chunkCharacters < text.length; part++) {
        const body = text.slice(part * chunkCharacters, (part + 1) * chunkCharacters);
        this.sql().exec("INSERT OR REPLACE INTO build_chunks (hash, part, body) VALUES (?, ?, ?)", build.hash, part, body);
      }
      kv.put("preview", build.hash);
    });
    return { accepted: true };
  }

  /** The hash of the Build the Preview runs, or null before the first successful Build. */
  previewHash(): string | null {
    return this.ctx.storage.kv.get<string>("preview") ?? null;
  }

  /** Deletes the app with its Workspace (ADR 0009): its Builds, logs, sign-in links and sessions. */
  async remove(workspaceId: string): Promise<void> {
    if (this.workspaceId() !== workspaceId) return;
    await this.ctx.storage.deleteAll();
    this.loaded = null;
    this.tablesReady = false;
  }

  /**
   * A single-use link that signs the Workspace's Developer in to the Preview
   * and then shows `to`. It works once, within a minute, and only opened the
   * way it was meant for: in the Preview pane's frame, or in a tab.
   */
  mintSignIn(workspaceId: string, label: string, destination: SignInDestination, to: string): string | null {
    if (!this.claim(workspaceId, label)) return null;
    const token = randomToken();
    const sql = this.sql();
    sql.exec("DELETE FROM sign_ins WHERE expires_at <= ?", Date.now());
    sql.exec(
      "INSERT INTO sign_ins (token, destination, path, expires_at) VALUES (?, ?, ?, ?)",
      token,
      destination,
      safePath(to),
      Date.now() + signInSeconds * 1000,
    );
    return `https://${previewHost(label, this.env.APPS_DOMAIN)}${signInPath}?t=${token}`;
  }

  /**
   * A request for the Preview, or for the Deployment once the platform
   * Worker has checked Access. The Preview needs a session of its own.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const slot = slotOf(url.hostname);
    if (this.workspaceId() === null) return new Response("There's no app here.", { status: 404 });
    if (slot === "deployment") return new Response("This app hasn't been published yet.", { status: 404 });

    if (url.pathname === signInPath) return this.signInWithLink(request, url);
    const session = this.sessionOf(request);
    if (!session) return this.signedOut(request, url);
    // Other apps on the apps domain are the same site, so the session cookie
    // goes with requests they send. Only the Preview's own pages may change things.
    // A WebSocket's handshake is a GET, so it's held to its Origin instead.
    const site = request.headers.get("Sec-Fetch-Site");
    const crossOrigin = site === "same-site" || site === "cross-site";
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if ((unsafeMethods.has(request.method) && crossOrigin) || (isUpgrade && request.headers.get("Origin") !== url.origin)) {
      return new Response("Requests that change things must come from the Preview's own pages.", { status: 403 });
    }
    return this.serve(request, slot, session.destination === "iframe");
  }

  /**
   * Sends the Preview a request for the Agent, as a browser would, and
   * returns what came back: the start of the body only, read no further.
   */
  async requestPreview(init: PreviewRequest): Promise<PreviewExchange> {
    const label = this.ctx.storage.kv.get<string>("label");
    if (!label) return { status: 503, headers: {}, body: notReady, truncated: false };
    const path = init.path.startsWith("/") ? init.path : `/${init.path}`;
    const deadline = Date.now() + previewWaitSeconds * 1000;
    const response = await beforeDeadline(this.serve(
      new Request(`https://${previewHost(label, this.env.APPS_DOMAIN)}${path}`, {
        method: init.method,
        headers: init.headers,
        body: init.body && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      }),
      "preview",
      false,
    ), deadline);
    if (!response) return { status: 504, headers: {}, body: `The Preview didn't answer within ${previewWaitSeconds} seconds.`, truncated: false };
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      ...(await readUpTo(response, previewBodyShown, deadline)),
    };
  }

  /** Adds lines to a slot's logs, keeping only the newest. */
  log(slot: Slot, source: AppLogEntry["source"], entries: { level: string; message: string }[]): void {
    const at = new Date().toISOString();
    const sql = this.sql();
    for (const { level, message } of entries) {
      sql.exec("INSERT INTO logs (at, slot, source, level, message) VALUES (?, ?, ?, ?, ?)", at, slot, source, level, message.slice(0, logLineLength));
    }
    sql.exec("DELETE FROM logs WHERE slot = ? AND id NOT IN (SELECT id FROM logs WHERE slot = ? ORDER BY id DESC LIMIT ?)", slot, slot, logsKept);
  }

  /** A slot's newest log lines, oldest first. */
  logs(slot: Slot, limit = 100): AppLogEntry[] {
    if (this.workspaceId() === null) return [];
    return this.sql()
      .exec<{ at: string; slot: Slot; source: AppLogEntry["source"]; level: string; message: string }>(
        "SELECT at, slot, source, level, message FROM (SELECT * FROM logs WHERE slot = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
        slot,
        Math.min(Math.max(limit, 1), logsKept),
      )
      .toArray();
  }

  /**
   * Gives an unclaimed label to a Workspace, and says whether the label is
   * that Workspace's. Tables are made only once an app exists, so a request
   * for a made-up hostname leaves nothing behind.
   */
  private claim(workspaceId: string, label: string): boolean {
    const owner = this.workspaceId();
    if (owner !== null) return owner === workspaceId;
    this.ctx.storage.kv.put("workspace", workspaceId);
    this.ctx.storage.kv.put("label", label);
    return true;
  }

  private sql(): SqlStorage {
    if (!this.tablesReady) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS build_chunks (hash TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (hash, part));
        CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, slot TEXT NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sign_ins (token TEXT PRIMARY KEY, destination TEXT NOT NULL, path TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, destination TEXT NOT NULL, expires_at INTEGER NOT NULL);
      `);
      this.tablesReady = true;
    }
    return this.ctx.storage.sql;
  }

  /**
   * Swaps a sign-in link for a session, once. The redirect takes the token
   * out of the address bar. In the pane's frame the cookie is partitioned,
   * because browsers keep a cross-site frame's cookies apart; in a tab it's
   * the Preview's own (ADR 0013).
   */
  private signInWithLink(request: Request, url: URL): Response {
    const token = url.searchParams.get("t") ?? "";
    const sql = this.sql();
    const signIn = sql
      .exec<{ destination: SignInDestination; path: string; expires_at: number }>(
        "SELECT destination, path, expires_at FROM sign_ins WHERE token = ?",
        token,
      )
      .toArray()[0];
    if (signIn) sql.exec("DELETE FROM sign_ins WHERE token = ?", token);
    const openedAs = request.headers.get("Sec-Fetch-Dest");
    if (!signIn || signIn.expires_at <= Date.now() || openedAs !== signIn.destination) {
      return new Response("This sign-in link has expired or was already used. Open the Preview from the Workspace page again.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const id = randomToken();
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
    sql.exec("INSERT INTO sessions (id, destination, expires_at) VALUES (?, ?, ?)", id, signIn.destination, Date.now() + sessionSeconds * 1000);
    const attributes =
      signIn.destination === "iframe" ? "SameSite=None; Partitioned" : "SameSite=Lax";
    return new Response(null, {
      status: 303,
      headers: {
        Location: signIn.path,
        "Cache-Control": "no-store",
        "Set-Cookie": `${sessionCookie}=${id}; Path=/; Secure; HttpOnly; ${attributes}; Max-Age=${sessionSeconds}`,
      },
    });
  }

  private sessionOf(request: Request): { destination: SignInDestination } | null {
    const id = cookieValue(request.headers.get("Cookie"), sessionCookie);
    if (!id) return null;
    const session = this.sql()
      .exec<{ destination: SignInDestination }>("SELECT destination FROM sessions WHERE id = ? AND expires_at > ?", id, Date.now())
      .toArray()[0];
    return session ?? null;
  }

  /**
   * Without a session: a page opened in a tab goes through the platform,
   * which is behind Access and sends it back with a sign-in link; the pane's
   * frame tells the platform's page to make a new link; anything else is refused.
   */
  private signedOut(request: Request, url: URL): Response {
    const platform = this.env.PLATFORM_ORIGIN;
    const openedAs = request.headers.get("Sec-Fetch-Dest");
    if (openedAs === "document" && request.method === "GET") {
      const signIn = new URL("/preview-sign-in", platform);
      signIn.searchParams.set("host", url.hostname);
      signIn.searchParams.set("to", url.pathname + url.search);
      return new Response(null, { status: 303, headers: { Location: signIn.href, "Cache-Control": "no-store" } });
    }
    if (openedAs === "iframe") {
      const page = `<!doctype html><meta charset="utf-8"><title>Signing in</title><p>Signing in to the Preview…</p><script>parent.postMessage({ type: "jigworks:preview-signed-out" }, ${JSON.stringify(platform)});</script>`;
      return new Response(page, {
        status: 401,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": `frame-ancestors ${platform}`,
        },
      });
    }
    return new Response("Open the Preview from the Workspace page to sign in.", { status: 401 });
  }

  /** Runs the request through the slot's Build. `inFrame` says it came from the Preview pane's frame. */
  private async serve(request: Request, slot: Slot, inFrame: boolean): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === browserErrorsPath) return this.receiveBrowserErrors(request, slot);
    if (pathname.startsWith(reservedPaths)) return new Response("Not found.", { status: 404 });
    const build = this.previewBuild();
    if (!build) return new Response(notReady, { status: 503 });
    const asset = assetResponse(request, build);
    if (asset) return this.fromApp(asset, slot, inFrame);

    const label = this.ctx.storage.kv.get<string>("label")!;
    const worker = this.env.LOADER.get(`app:${label}:${slot}:${build.hash}`, async () => ({
      compatibilityDate: build.compatibilityDate ?? fallbackCompatibilityDate,
      compatibilityFlags: build.compatibilityFlags,
      mainModule: build.mainModule,
      modules: build.modules as WorkerLoaderWorkerCode["modules"],
      env: build.vars,
      limits: appLimits,
      tails: [this.ctx.exports.AppTail({ props: { label, slot } })],
    }));
    let response: Response;
    try {
      response = await worker.getEntrypoint().fetch(forApp(request));
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.log(slot, "server", [{ level: "exception", message }]);
      return new Response(`The app threw an error: ${message}`, { status: 500 });
    }
    return this.fromApp(response, slot, inFrame);
  }

  private previewBuild(): KeptBuild | null {
    const hash = this.previewHash();
    if (!hash) return null;
    if (this.loaded?.hash !== hash) {
      const parts = this.sql().exec<{ body: string }>("SELECT body FROM build_chunks WHERE hash = ? ORDER BY part", hash).toArray();
      this.loaded = JSON.parse(parts.map(({ body }) => body).join("")) as KeptBuild;
    }
    return this.loaded;
  }

  private async receiveBrowserErrors(request: Request, slot: Slot): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const text = (await request.text()).slice(0, logLineLength * 2);
    let report: { kind?: unknown; message?: unknown };
    try {
      report = JSON.parse(text) as typeof report;
    } catch {
      return new Response(null, { status: 400 });
    }
    this.log(slot, "browser", [{ level: String(report.kind ?? "error"), message: String(report.message ?? "") }]);
    return new Response(null, { status: 204 });
  }

  /**
   * Passes only `__Host-` cookies from app code to the browser (ADR 0012),
   * and never the Preview's own. In the pane's frame they're made
   * partitioned, so an app's own sign-in works there too. Only the
   * platform's pages may frame the Preview, and HTML pages get the script
   * that reports front-end errors.
   */
  private fromApp(response: Response, slot: Slot, inFrame: boolean): Response {
    const headers = new Headers(response.headers);
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      headers.delete("Set-Cookie");
      for (const cookie of cookies) {
        const name = cookie.split("=", 1)[0]!.trim();
        if (name.startsWith("__Host-") && name !== sessionCookie) headers.append("Set-Cookie", inFrame ? partitioned(cookie) : cookie);
        else {
          const reason = name === sessionCookie ? "that name is the Preview's own" : "apps may only set cookies whose names start with __Host-";
          this.log(slot, "server", [{ level: "warn", message: `Dropped the cookie "${name}": ${reason}.` }]);
        }
      }
    }
    // A WebSocket's handshake keeps its socket, and the cookie rules above.
    if (response.webSocket) return new Response(null, { status: 101, webSocket: response.webSocket, headers });
    if (slot === "preview") headers.append("Content-Security-Policy", `frame-ancestors 'self' ${this.env.PLATFORM_ORIGIN}`);
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    if (!headers.get("Content-Type")?.includes("text/html")) return result;
    // Ahead of the page's own scripts: at the start of its <head> or <body>,
    // or before its first tag if it has neither.
    let injected = false;
    return new HTMLRewriter()
      .on("*", {
        element: (element) => {
          if (injected || element.tagName === "html") return;
          injected = true;
          if (element.tagName === "head" || element.tagName === "body") element.prepend(browserErrorScript, { html: true });
          else element.before(browserErrorScript, { html: true });
        },
      })
      .transform(result);
  }
}

/**
 * Receives an app's server logs from its Dynamic Worker's tail and keeps them
 * in its app host.
 */
export class AppTail extends WorkerEntrypoint<Env, { label: string; slot: Slot }> {
  override async tail(events: TraceItem[]): Promise<void> {
    const entries = events.flatMap((event) => [
      ...event.logs.map(({ level, message }) => ({ level, message: (message as unknown[]).map(asText).join(" ") })),
      ...event.exceptions.map(({ name, message }) => ({ level: "exception", message: `${name}: ${message}` })),
    ]);
    if (entries.length === 0) return;
    const { label, slot } = this.ctx.props;
    await this.env.APP_HOSTS.getByName(label).log(slot, "server", entries);
  }
}

/** The Preview of `<label>-preview.<apps domain>`, otherwise the Deployment. */
export function slotOf(hostname: string): Slot {
  return hostname.split(".", 1)[0]!.endsWith("-preview") ? "preview" : "deployment";
}

/** The Preview's hostname for an app's label: `<label>-preview.<apps domain>`. */
export function previewHost(label: string, appsDomain: string): string {
  return `${label}-preview.${appsDomain}`;
}

/** An app's label from its hostname, such as `notes-k3x9p2qa` from `notes-k3x9p2qa-preview.jigworks.app`. */
export function labelOf(hostname: string): string {
  return hostname.split(".", 1)[0]!.replace(/-preview$/, "");
}

/** Whether a label is one the platform could have given: a slug, then 8 letters and digits. */
export function isAppLabel(label: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{8}$/.test(label) && label.length <= 40;
}

/** A new app label for a Workspace: its name as a slug, then 8 random letters and digits. */
export function newAppLabel(workspaceName: string): string {
  const slug =
    workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20)
      .replace(/-+$/, "") || "app";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const random = [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${slug}-${random}`;
}

/**
 * The request as app code sees it: without Access's headers or cookie, and
 * with only `__Host-` cookies other than the Preview's own, so no other
 * site's cookies reach app code (ADR 0012).
 */
export function forApp(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("cf-access-")) headers.delete(name);
  const cookies = (headers.get("Cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith("__Host-") && !cookie.startsWith(`${sessionCookie}=`));
  if (cookies.length > 0) headers.set("Cookie", cookies.join("; "));
  else headers.delete("Cookie");
  return new Request(request, { headers });
}

/**
 * The start of a response's body, up to `characters` or whatever arrived by
 * `deadline`, reading no further, so a long, endless or stalled body can't
 * hold up the Agent.
 */
async function readUpTo(response: Response, characters: number, deadline: number): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (body.length <= characters) {
    const chunk = await beforeDeadline(reader.read(), deadline);
    if (!chunk) break;
    if (chunk.done) return { body: body + decoder.decode(), truncated: false };
    body += decoder.decode(chunk.value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return { body: body.slice(0, characters), truncated: true };
}

/** What `promise` gives, or null if `deadline` comes first. */
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A path on the Preview to go to after signing in: never another site. */
function safePath(to: string): string {
  // Resolved as a browser would resolve the Location header, which ignores
  // tabs and newlines and reads a backslash as a slash.
  const base = "https://preview.invalid";
  const url = URL.parse(to, base);
  return to.startsWith("/") && url?.origin === base ? url.pathname + url.search + url.hash : "/";
}

/** A cookie made to work in a cross-site frame: partitioned, and sent with cross-site requests. */
function partitioned(cookie: string): string {
  const attributes = cookie.split(";").filter((part) => !/^\s*(samesite|partitioned)\b/i.test(part));
  return [...attributes, " SameSite=None", " Partitioned"].join(";");
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Reports a page's uncaught errors, rejected promises and console.error calls
// to the app host, which keeps them in the Preview's logs.
const browserErrorScript = `<script>(() => {
  const send = (kind, message) => { try { navigator.sendBeacon(${JSON.stringify(browserErrorsPath)}, JSON.stringify({ kind, message: String(message).slice(0, ${logLineLength}) })); } catch {} };
  addEventListener("error", (event) => send("error", event.message + (event.filename ? " (" + event.filename + ":" + event.lineno + ":" + event.colno + ")" : "")));
  addEventListener("unhandledrejection", (event) => send("unhandledrejection", (event.reason && event.reason.stack) || event.reason));
  const original = console.error;
  console.error = (...args) => { send("console.error", args.map(String).join(" ")); original.apply(console, args); };
})();</script>`;
