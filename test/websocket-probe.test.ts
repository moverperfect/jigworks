import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BuildReport } from "../src/shared/build-report";
import type { Deployment } from "../src/shared/deployment";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";

// Throwaway probe for #109: WebSockets into an app's Durable Objects. Not for main.

const build = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/build`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<BuildReport>();
};
const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};
const publish = async (id: string, replaces: string | null) => {
  const response = await call(`/api/workspaces/${id}/deployment`, { method: "POST", body: { replaces } });
  expect(response.status).toBe(200);
  return response.json<Deployment>();
};
const previewUrl = async (id: string) => (await (await call(`/api/workspaces/${id}/preview`)).json<{ url: string }>()).url;
const signIn = async (id: string) => {
  const host = new URL(await previewUrl(id)).hostname;
  const page = await exports.default.fetch(
    new Request(`${testAccess.origin}/preview-sign-in?host=${host}&to=%2F`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessToken({ email: testAccess.developer }) },
      redirect: "manual",
    }),
  );
  const link = page.headers.get("Location")!;
  const response = await exports.default.fetch(new Request(link, { headers: { "Sec-Fetch-Dest": "document" }, redirect: "manual" }));
  expect(response.status).toBe(303);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
};

/** A browser's request to the slot, upgraded if `upgrade`. */
async function open(base: string, path: string, { cookie, upgrade = false, method = "GET" }: { cookie?: string; upgrade?: boolean; method?: string } = {}) {
  const url = new URL(path, base);
  const headers = new Headers({ "Sec-Fetch-Dest": "empty", Origin: url.origin, "Sec-Fetch-Site": "same-origin" });
  if (cookie) headers.set("Cookie", cookie);
  else headers.set("Cf-Access-Jwt-Assertion", await accessToken({ email: "colleague@example.com" }, { audience: testAccess.appsAudience }));
  if (upgrade) headers.set("Upgrade", "websocket");
  return exports.default.fetch(new Request(url, { method, headers, redirect: "manual" }));
}

/** A client socket that keeps every message and its close. */
function client(response: Response) {
  const socket = response.webSocket!;
  const messages: string[] = [];
  const closed: { code?: number; reason?: string } = {};
  socket.accept();
  socket.addEventListener("message", (event) => messages.push(String(event.data)));
  socket.addEventListener("close", (event) => Object.assign(closed, { code: event.code, reason: event.reason }));
  socket.addEventListener("error", (event) => Object.assign(closed, { error: String((event as ErrorEvent).message ?? event) }));
  return { socket, messages, closed };
}

const until = async (done: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  return done();
};

const wrangler = JSON.stringify({
  name: "app",
  main: "src/index.ts",
  compatibility_date: "2026-10-01",
  durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
});

/** A room whose instances hold sockets, by hibernation (`acceptWebSocket`) or by `accept()`. */
const roomApp = (version: string) => `import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.storage.kv.put("starts", (ctx.storage.kv.get<number>("starts") ?? 0) + 1);
    ctx.storage.kv.put("startedAt", [...(ctx.storage.kv.get<number[]>("startedAt") ?? []), Date.now()]);
  }
  plain = new Set<WebSocket>();

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("${version} room", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    if (new URL(request.url).searchParams.get("mode") === "plain") {
      server.accept();
      this.plain.add(server);
      server.addEventListener("message", (event) => this.send("${version} plain " + (String(event.data).length > 1000 ? String(event.data).length + " bytes" : event.data)));
      server.addEventListener("close", () => this.plain.delete(server));
    } else {
      this.ctx.acceptWebSocket(server, ["t"]);
    }
    server.send("${version} hello " + this.ctx.storage.kv.get("starts"));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 1000) return this.send("${version} heard " + (typeof message === "string" ? message.length : message.byteLength) + " bytes");
    this.send("${version} heard " + String(message));
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, "bye");
  }

  send(text: string): number {
    const sockets = [...this.ctx.getWebSockets(), ...this.plain];
    for (const socket of sockets) socket.send(text);
    return sockets.length;
  }

  async broadcast(text: string): Promise<number> {
    return this.send("${version} " + text);
  }

  async startedAt(): Promise<number[]> {
    return this.ctx.storage.kv.get<number[]>("startedAt") ?? [];
  }

  async starts(): Promise<number> {
    return this.ctx.storage.kv.get<number>("starts") ?? 0;
  }
}

export default {
  async fetch(request: Request, env: { ROOM: DurableObjectNamespace<Room> }): Promise<Response> {
    const url = new URL(request.url);
    const room = env.ROOM.getByName(url.searchParams.get("room") ?? "a");
    if (url.pathname === "/socket") {
      try {
        return await room.fetch(request);
      } catch (error) {
        return new Response("forward failed: " + String(error), { status: 500 });
      }
    }
    if (url.pathname === "/broadcast") return new Response(String(await room.broadcast(url.searchParams.get("text") ?? "")));
    if (url.pathname === "/startedAt") return Response.json(await room.startedAt());
    if (url.pathname === "/starts") return new Response(String(await room.starts()));
    return new Response("${version}", { status: 404 });
  },
};
`;

const roomWorkspace = async (name: string) => {
  const workspace = await create(name);
  await save(workspace.id, "wrangler.jsonc", wrangler);
  await save(workspace.id, "src/index.ts", roomApp("v1"));
  expect(await build(workspace.id)).toMatchObject({ ok: true });
  return workspace;
};

describe("today: an upgrade forwarded to an instance", () => {
  it("in the Preview", async () => {
    const workspace = await roomWorkspace("Sockets Today");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const seen: string[] = [];
    for (const mode of ["", "&mode=plain"]) {
      const response = await open(base, `/socket?room=a${mode}`, { cookie, upgrade: true });
      seen.push(`preview ${mode || "hibernation"} ${response.status} ${response.webSocket ? "socket" : await response.text()}`);
    }
    seen.push("starts " + (await (await open(base, "/starts", { cookie })).text()));
    expect(seen).toEqual([]);
  });
});

/** Opens `count` sockets to a room. */
const sockets = async (base: string, query: string, count: number, cookie?: string) => {
  const opened = [];
  for (let i = 0; i < count; i++) {
    const response = await open(base, `/socket?${query}`, { cookie, upgrade: true });
    if (response.status !== 101) throw new Error(`${response.status} ${await response.text()}`);
    opened.push(client(response));
  }
  return opened;
};

describe("probe: upgrades over fetch", () => {
  it("broadcasts, in both modes, and keeps slots apart", async () => {
    const workspace = await roomWorkspace("Sockets Probe");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const seen: unknown[] = [];
    for (const mode of ["hibernation", "plain"]) {
      const q = mode === "plain" ? "room=p&mode=plain" : "room=h";
      const [a, b] = await sockets(base, q, 2, cookie);
      a!.socket.send("x");
      await until(() => b!.messages.length >= 2);
      const count = await (await open(base, `/broadcast?${q}&text=y`, { cookie })).text();
      await until(() => a!.messages.length >= 3 && b!.messages.length >= 3);
      seen.push({ mode, count, a: a!.messages, b: b!.messages });
    }
    const { url } = await publish(workspace.id, null);
    const [d] = await sockets(url, "room=h", 1);
    const previewCount = await (await open(base, `/broadcast?room=h&text=z`, { cookie })).text();
    const deploymentCount = await (await open(url, `/broadcast?room=h&text=z`)).text();
    await until(() => d!.messages.length >= 2);
    seen.push({ previewCount, deploymentCount, d: d!.messages });
    expect(seen).toEqual([]);
  });

  it("on a new Build", async () => {
    const workspace = await roomWorkspace("Sockets Build");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const [h] = await sockets(base, "room=h", 1, cookie);
    const [p] = await sockets(base, "room=p&mode=plain", 1, cookie);
    const started = Date.now();
    await save(workspace.id, "src/index.ts", roomApp("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await until(() => h!.closed.code !== undefined && p!.closed.code !== undefined, 3000);
    const closedAfter = Date.now() - started;
    const afterH = await (await open(base, `/broadcast?room=h&text=after`, { cookie })).text();
    const afterP = await (await open(base, `/broadcast?room=p&text=after`, { cookie })).text();
    let sendError = "";
    try {
      h!.socket.send("still there?");
    } catch (error) {
      sendError = String(error);
    }
    await until(() => false, 500);
    expect({ closedAfter, h, p, afterH, afterP, sendError, starts: await (await open(base, "/starts?room=h", { cookie })).text() }).toEqual({});
  });

  it("hibernates when idle", async () => {
    const workspace = await roomWorkspace("Sockets Idle");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const [h] = await sockets(base, "room=h", 1, cookie);
    const [p] = await sockets(base, "room=p&mode=plain", 1, cookie);
    const before = [await (await open(base, "/starts?room=h", { cookie })).text(), await (await open(base, "/starts?room=p", { cookie })).text()];
    await until(() => false, 75_000);
    h!.socket.send("wake");
    p!.socket.send("wake");
    await until(() => h!.messages.length >= 2 && p!.messages.length >= 2);
    const after = [await (await open(base, "/starts?room=h", { cookie })).text(), await (await open(base, "/starts?room=p", { cookie })).text()];
    expect({ before, after, h: h!.messages, p: p!.messages, closed: [h!.closed, p!.closed] }).toEqual({});
  });
});

describe("probe: more", () => {
  it("a new Build leaves the Deployment's sockets; a publish closes them", async () => {
    const workspace = await roomWorkspace("Sockets Slots");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const first = await publish(workspace.id, null);
    const [d] = await sockets(first.url, "room=h", 1);
    const [pv] = await sockets(base, "room=h", 1, cookie);
    await save(workspace.id, "src/index.ts", roomApp("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await until(() => pv!.closed.code !== undefined);
    const countAfterBuild = await (await open(first.url, "/broadcast?room=h&text=after-build")).text();
    await until(() => d!.messages.length >= 2);
    const dAfterBuild = { ...d!.closed, messages: [...d!.messages] };
    await publish(workspace.id, first.hash);
    await until(() => d!.closed.code !== undefined);
    expect({ pv: pv!.closed, countAfterBuild, dAfterBuild, dAfterPublish: d!.closed }).toEqual({});
  });

  it("auto-responds without waking, and takes big messages and many sockets", async () => {
    const workspace = await roomWorkspace("Sockets Limits");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const [h] = await sockets(base, "room=h", 1, cookie);
    await until(() => false, 75_000);
    h!.socket.send("ping");
    await until(() => h!.messages.length >= 2);
    const startsAfterPing = await (await open(base, "/starts?room=h", { cookie })).text();
    const sizes: Record<string, string> = {};
    for (const mb of [1, 4, 16, 33]) {
      const before = h!.messages.length;
      try {
        h!.socket.send("x".repeat(mb * 1024 * 1024));
        await until(() => h!.messages.length > before || h!.closed.code !== undefined, 5000);
        sizes[mb + " MiB"] = h!.messages.at(-1) + " " + JSON.stringify(h!.closed);
      } catch (error) {
        sizes[mb + " MiB"] = "threw " + String(error);
      }
    }
    const many = await sockets(base, "room=m", 200, cookie);
    const count = await (await open(base, "/broadcast?room=m&text=all", { cookie })).text();
    await until(() => many.every((s) => s.messages.length >= 2));
    const reached = many.filter((s) => s.messages.includes("v1 all")).length;
    expect({ startsAfterPing, last: h!.messages.slice(0, 3), sizes, count, reached }).toEqual({});
  });
});

describe("probe: ping", () => {
  it("an auto-response doesn't wake the instance; a message does", async () => {
    const workspace = await roomWorkspace("Sockets Ping");
    const base = await previewUrl(workspace.id);
    const cookie = await signIn(workspace.id);
    const [h] = await sockets(base, "room=h", 1, cookie);
    const opened = Date.now();
    await until(() => false, 15_000);
    const pinged = Date.now();
    h!.socket.send("ping");
    await until(() => h!.messages.length >= 2);
    await until(() => false, 3_000);
    const messaged = Date.now();
    h!.socket.send("q");
    await until(() => h!.messages.length >= 3);
    const starts = (await (await open(base, "/startedAt?room=h", { cookie })).json<number[]>()).map((t) => t - opened);
    expect({ pinged: pinged - opened, messaged: messaged - opened, starts, messages: h!.messages }).toEqual({});
  });
});
