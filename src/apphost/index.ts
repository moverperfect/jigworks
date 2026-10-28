import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Build } from "../builder";

/** Which of an app's two faces a request is for: the Preview, or the Deployment (ticket 10). */
export type Slot = "preview" | "deployment";

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
// The path the injected script reports front-end errors to. App code never sees it.
export const browserErrorsPath = "/__jigworks/errors";

/**
 * One per app, named by its label (`<slug>-<random>`): the Workspace's
 * Preview and, from ticket 10, its Deployment (ADR 0009). It keeps the Build
 * each one runs, runs it on a Dynamic Worker, and keeps their logs. Requests
 * reach it only through the platform Worker's gate.
 */
export class AppHost extends DurableObject<Env> {
  private loaded: RunnableBuild | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS build_chunks (hash TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (hash, part));
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, slot TEXT NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
    `);
  }

  /** The Workspace this app belongs to, or null before its first Build. */
  workspaceId(): string | null {
    return this.ctx.storage.kv.get<string>("workspace") ?? null;
  }

  /**
   * Takes a Workspace's latest good Build as the Preview. A label belongs to
   * one Workspace for good, so another Workspace's Build is refused: its
   * Workspace then picks a new label.
   */
  receiveBuild(workspaceId: string, label: string, build: RunnableBuild): { accepted: boolean } {
    const owner = this.workspaceId();
    if (owner !== null && owner !== workspaceId) return { accepted: false };
    const kv = this.ctx.storage.kv;
    if (owner === null) {
      kv.put("workspace", workspaceId);
      kv.put("label", label);
    }
    const previous = kv.get<string>("preview");
    if (previous === build.hash) return { accepted: true };
    const { hash, mainModule, modules, compatibilityDate, compatibilityFlags, vars } = build;
    const text = JSON.stringify({ hash, mainModule, modules, compatibilityDate, compatibilityFlags, vars });
    this.ctx.storage.transactionSync(() => {
      if (previous) this.ctx.storage.sql.exec("DELETE FROM build_chunks WHERE hash = ?", previous);
      for (let part = 0; part * chunkCharacters < text.length; part++) {
        const body = text.slice(part * chunkCharacters, (part + 1) * chunkCharacters);
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO build_chunks (hash, part, body) VALUES (?, ?, ?)", hash, part, body);
      }
      kv.put("preview", hash);
    });
    return { accepted: true };
  }

  /** The hash of the Build the Preview runs, or null before the first good Build. */
  previewBuild(): string | null {
    return this.ctx.storage.kv.get<string>("preview") ?? null;
  }

  /** Serves a request that the platform Worker's gate has already let through. */
  override async fetch(request: Request): Promise<Response> {
    const slot = slotOf(new URL(request.url).hostname);
    const url = new URL(request.url);
    if (url.pathname === browserErrorsPath) return this.receiveBrowserErrors(request, slot);
    if (slot === "deployment") return new Response("This app hasn't been published yet.", { status: 404 });
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
    return this.fromApp(response, slot);
  }

  /** Sends the Preview a request for the Agent, as a browser would, and returns what came back. */
  async requestPreview(init: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<PreviewExchange> {
    const label = this.ctx.storage.kv.get<string>("label");
    if (!label) return { status: 503, headers: {}, body: "The Preview starts after the Workspace's first successful Build.", truncated: false };
    const path = init.path.startsWith("/") ? init.path : `/${init.path}`;
    const response = await this.fetch(
      new Request(`https://${label}-preview.${this.env.APPS_DOMAIN}${path}`, {
        method: init.method,
        headers: init.headers,
        body: init.body && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      }),
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
    const sql = this.ctx.storage.sql;
    for (const { level, message } of entries) {
      sql.exec("INSERT INTO logs (at, slot, source, level, message) VALUES (?, ?, ?, ?, ?)", at, slot, source, level, message.slice(0, logLineLength));
    }
    sql.exec("DELETE FROM logs WHERE slot = ? AND id NOT IN (SELECT id FROM logs WHERE slot = ? ORDER BY id DESC LIMIT ?)", slot, slot, logsKept);
  }

  /** A slot's newest log lines, oldest first. */
  logs(slot: Slot, limit = 100): AppLogEntry[] {
    return this.ctx.storage.sql
      .exec<{ at: string; slot: Slot; source: AppLogEntry["source"]; level: string; message: string }>(
        "SELECT at, slot, source, level, message FROM (SELECT * FROM logs WHERE slot = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
        slot,
        Math.min(Math.max(limit, 1), logsKept),
      )
      .toArray();
  }

  private previewBuildCode(): RunnableBuild | null {
    const hash = this.previewBuild();
    if (!hash) return null;
    if (this.loaded?.hash !== hash) {
      const parts = this.ctx.storage.sql
        .exec<{ body: string }>("SELECT body FROM build_chunks WHERE hash = ? ORDER BY part", hash)
        .toArray();
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
   * and adds the script that reports front-end errors to HTML pages.
   */
  private fromApp(response: Response, slot: Slot): Response {
    const headers = new Headers(response.headers);
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      headers.delete("Set-Cookie");
      for (const cookie of cookies) {
        if (cookie.startsWith("__Host-")) headers.append("Set-Cookie", cookie);
        else {
          const name = cookie.split("=", 1)[0]!.trim();
          this.log(slot, "server", [{ level: "warn", message: `Dropped the cookie "${name}": apps may only set cookies whose names start with __Host-.` }]);
        }
      }
    }
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
 * with only `__Host-` cookies, so no other site's cookies reach app code
 * (ADR 0012).
 */
export function forApp(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("cf-access-")) headers.delete(name);
  const cookies = (headers.get("Cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith("__Host-"));
  if (cookies.length > 0) headers.set("Cookie", cookies.join("; "));
  else headers.delete("Cookie");
  return new Request(request, { headers });
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
