import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Build } from "../builder";

/** Which of an app's two faces a request is for: the Preview, or the Deployment (ticket 10). */
export type Slot = "preview" | "deployment";

/** Where a Preview sign-in link opens: the Preview pane's frame, or a tab of its own. */
export type SignInDestination = "iframe" | "document";

/** One line in an app's logs: from its Worker, or from a browser running its pages. */
export interface AppLogEntry {
  at: string;
  slot: Slot;
  source: "server" | "browser";
  level: string;
  message: string;
}

/** A request the Agent sends the Preview, and what came back. */
export interface PreviewExchange {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Whether the body was cut short. */
  truncated: boolean;
}

/** The part of a Build that runs, as the app host keeps it. Assets come with ticket 09. */
type RunnableBuild = Pick<Build, "hash" | "mainModule" | "modules" | "compatibilityDate" | "compatibilityFlags" | "vars">;

interface Session {
  email: string;
  destination: SignInDestination;
}

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
  private loaded: RunnableBuild | null = null;
  private tablesReady = false;

  /** The Workspace this app belongs to, or null before it has one. */
  workspaceId(): string | null {
    return this.ctx.storage.kv.get<string>("workspace") ?? null;
  }

  /**
   * Takes a Workspace's latest good Build as the Preview. A label belongs to
   * one Workspace for good, so another Workspace's Build is refused: its
   * Workspace then picks a new label.
   */
  receiveBuild(workspaceId: string, label: string, build: RunnableBuild): { accepted: boolean } {
    if (!this.claim(workspaceId, label)) return { accepted: false };
    const kv = this.ctx.storage.kv;
    const previous = kv.get<string>("preview");
    if (previous === build.hash) return { accepted: true };
    const { hash, mainModule, modules, compatibilityDate, compatibilityFlags, vars } = build;
    const text = JSON.stringify({ hash, mainModule, modules, compatibilityDate, compatibilityFlags, vars });
    this.ctx.storage.transactionSync(() => {
      if (previous) this.sql().exec("DELETE FROM build_chunks WHERE hash = ?", previous);
      for (let part = 0; part * chunkCharacters < text.length; part++) {
        const body = text.slice(part * chunkCharacters, (part + 1) * chunkCharacters);
        this.sql().exec("INSERT OR REPLACE INTO build_chunks (hash, part, body) VALUES (?, ?, ?)", hash, part, body);
      }
      kv.put("preview", hash);
    });
    return { accepted: true };
  }

  /** The hash of the Build the Preview runs, or null before the first good Build. */
  previewBuild(): string | null {
    return this.ctx.storage.kv.get<string>("preview") ?? null;
  }

  /**
   * A single-use link that signs the Workspace's Developer in to the Preview
   * and then shows `to`. It works once, within a minute, and only opened the
   * way it was meant for: in the Preview pane's frame, or in a tab.
   */
  mintSignIn(workspaceId: string, label: string, email: string, destination: SignInDestination, to: string): string | null {
    if (!this.claim(workspaceId, label)) return null;
    const token = randomToken();
    const sql = this.sql();
    sql.exec("DELETE FROM sign_ins WHERE expires_at <= ?", Date.now());
    sql.exec(
      "INSERT INTO sign_ins (token, email, destination, path, expires_at) VALUES (?, ?, ?, ?, ?)",
      token,
      email,
      destination,
      safePath(to),
      Date.now() + signInSeconds * 1000,
    );
    return `https://${label}-preview.${this.env.APPS_DOMAIN}${signInPath}?t=${token}`;
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

    if (url.pathname === signInPath) return this.exchange(request, url);
    const session = this.sessionOf(request);
    if (!session) return this.signedOut(request, url);
    // Other apps on the apps domain are the same site, so the session cookie
    // goes with requests they send. Only the Preview's own pages may change things.
    const site = request.headers.get("Sec-Fetch-Site");
    if (unsafeMethods.has(request.method) && (site === "same-site" || site === "cross-site")) {
      return new Response("Requests that change things must come from the Preview's own pages.", { status: 403 });
    }
    return this.serve(request, slot, session);
  }

  /** Sends the Preview a request for the Agent, as a browser would, and returns what came back. */
  async requestPreview(init: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<PreviewExchange> {
    const label = this.ctx.storage.kv.get<string>("label");
    if (!label) return { status: 503, headers: {}, body: "The Preview starts after the Workspace's first successful Build.", truncated: false };
    const path = init.path.startsWith("/") ? init.path : `/${init.path}`;
    const response = await this.serve(
      new Request(`https://${label}-preview.${this.env.APPS_DOMAIN}${path}`, {
        method: init.method,
        headers: init.headers,
        body: init.body && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      }),
      "preview",
      null,
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: text.slice(0, previewBodyShown),
      truncated: text.length > previewBodyShown,
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
        CREATE TABLE IF NOT EXISTS sign_ins (token TEXT PRIMARY KEY, email TEXT NOT NULL, destination TEXT NOT NULL, path TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT NOT NULL, destination TEXT NOT NULL, expires_at INTEGER NOT NULL);
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
  private exchange(request: Request, url: URL): Response {
    const token = url.searchParams.get("t") ?? "";
    const sql = this.sql();
    const signIn = sql
      .exec<{ email: string; destination: SignInDestination; path: string; expires_at: number }>(
        "SELECT email, destination, path, expires_at FROM sign_ins WHERE token = ?",
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
    sql.exec(
      "INSERT INTO sessions (id, email, destination, expires_at) VALUES (?, ?, ?, ?)",
      id,
      signIn.email,
      signIn.destination,
      Date.now() + sessionSeconds * 1000,
    );
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

  private sessionOf(request: Request): Session | null {
    const id = cookieValue(request.headers.get("Cookie"), sessionCookie);
    if (!id) return null;
    const session = this.sql()
      .exec<{ email: string; destination: SignInDestination }>(
        "SELECT email, destination FROM sessions WHERE id = ? AND expires_at > ?",
        id,
        Date.now(),
      )
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

  /** Runs the request through the slot's Build. `session` is null for the Agent's own requests. */
  private async serve(request: Request, slot: Slot, session: Session | null): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === browserErrorsPath) return this.receiveBrowserErrors(request, slot);
    if (pathname.startsWith(reservedPaths)) return new Response("Not found.", { status: 404 });
    const build = this.previewBuildCode();
    if (!build) return new Response("The Preview starts after the Workspace's first successful Build.", { status: 503 });

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
    return this.fromApp(response, slot, session?.destination === "iframe");
  }

  private previewBuildCode(): RunnableBuild | null {
    const hash = this.previewBuild();
    if (!hash) return null;
    if (this.loaded?.hash !== hash) {
      const parts = this.sql().exec<{ body: string }>("SELECT body FROM build_chunks WHERE hash = ? ORDER BY part", hash).toArray();
      this.loaded = JSON.parse(parts.map(({ body }) => body).join("")) as RunnableBuild;
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
    if (slot === "preview") headers.append("Content-Security-Policy", `frame-ancestors ${this.env.PLATFORM_ORIGIN}`);
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    if (!headers.get("Content-Type")?.includes("text/html")) return result;
    return new HTMLRewriter()
      .on("head", {
        element: (head) => {
          head.prepend(browserErrorScript, { html: true });
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

/** A path on the Preview to go to after signing in: never another site. */
function safePath(to: string): string {
  return to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/";
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
