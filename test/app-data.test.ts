import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { BuildReport } from "../src/shared/build-report";
import type { Deployment } from "../src/shared/deployment";
import { accessToken, testAccess } from "./helpers/access";
import { call, create, waitFor } from "./helpers/api";

// App data: an app's Durable Object binding, with each instance a facet in
// the app host, and the Preview's data kept apart from the Deployment's
// (ADR 0006).

const build = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/build`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<BuildReport>();
};

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};

const wrangler = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "app",
    main: "src/index.ts",
    compatibility_date: "2026-10-01",
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    ...extra,
  });

/** An app whose Counter instances count by name, answering with `prefix` and the count. */
const counterApp = (prefix = "") => `import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  // Each instance's own SQLite database.
  private count(): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS clicks (at INTEGER NOT NULL)");
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM clicks").one().n;
  }

  async increment(): Promise<number> {
    this.count();
    this.ctx.storage.sql.exec("INSERT INTO clicks VALUES (?)", Date.now());
    return this.count();
  }

  override async fetch(): Promise<Response> {
    return new Response(String(this.count()));
  }

  async whoami(): Promise<{ id: string; name: string | null }> {
    return { id: this.ctx.id.toString(), name: this.ctx.id.name ?? null };
  }
}

export default {
  async fetch(request: Request, env: { COUNTER: DurableObjectNamespace<Counter> }): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "a";
    if (url.pathname === "/increment") return new Response(${JSON.stringify(prefix)} + (await env.COUNTER.getByName(name).increment()));
    if (url.pathname === "/read") return env.COUNTER.get(env.COUNTER.idFromName(name)).fetch(request);
    if (url.pathname === "/whoami") return Response.json(await env.COUNTER.getByName(name).whoami());
    if (url.pathname === "/id") {
      const id = env.COUNTER.idFromName(name);
      return Response.json({ id: id.toString(), same: id.equals(env.COUNTER.idFromString(id.toString())), name: id.name });
    }
    return new Response("not found", { status: 404 });
  },
};
`;

const counterWorkspace = async (name: string) => {
  const workspace = await create(name);
  await save(workspace.id, "wrangler.jsonc", wrangler());
  await save(workspace.id, "src/index.ts", counterApp());
  expect(await build(workspace.id)).toMatchObject({ ok: true });
  return workspace;
};

/** Sends the Preview a request, as the Agent does. */
const inPreview = async (id: string, path: string) =>
  (await env.WORKSPACES.getByName(id).requestPreview({ method: "GET", path })).body;

/** Sends the Deployment a request, as someone the apps' Access application let in. */
const inDeployment = async (url: string, path: string) => {
  const token = await accessToken({ email: "colleague@example.com" }, { audience: testAccess.appsAudience });
  const response = await exports.default.fetch(new Request(new URL(path, url), { headers: { "Cf-Access-Jwt-Assertion": token } }));
  return response.text();
};

const publish = async (id: string, replaces: string | null) => {
  const response = await call(`/api/workspaces/${id}/deployment`, { method: "POST", body: { replaces } });
  expect(response.status).toBe(200);
  return response.json<Deployment>();
};

describe("an app's Durable Object binding", () => {
  it("reaches instances by name, each with storage of its own", async () => {
    const workspace = await counterWorkspace("Data Names");
    expect(await inPreview(workspace.id, "/increment?name=a")).toBe("1");
    expect(await inPreview(workspace.id, "/increment?name=a")).toBe("2");
    expect(await inPreview(workspace.id, "/increment?name=b")).toBe("1");
    expect(await inPreview(workspace.id, "/read?name=a")).toBe("2");
    const ids = JSON.parse(await inPreview(workspace.id, "/id?name=a")) as { id: string; same: boolean; name: string };
    expect(ids).toEqual({ id: expect.stringMatching(/^[0-9a-f]{64}$/), same: true, name: "a" });

    // Each instance has an ID of its own, with its name when it was reached by name.
    const a = JSON.parse(await inPreview(workspace.id, "/whoami?name=a")) as { id: string; name: string };
    const b = JSON.parse(await inPreview(workspace.id, "/whoami?name=b")) as { id: string; name: string };
    expect([a.name, b.name]).toEqual(["a", "b"]);
    expect(a.id).not.toBe(b.id);
  });

  it("works whatever the class is called, even a name the platform's own code uses", async () => {
    const workspace = await create("Data Class Names");
    await save(
      workspace.id,
      "wrangler.jsonc",
      wrangler({
        durable_objects: {
          bindings: [
            { name: "IDS", class_name: "Id" },
            { name: "REQUESTS", class_name: "Request" },
          ],
        },
      }),
    );
    await save(
      workspace.id,
      "src/index.ts",
      `import { DurableObject } from "cloudflare:workers";
export class Id extends DurableObject { hello() { return "id"; } }
class Requests extends DurableObject { hello() { return "request"; } }
export { Requests as Request };
export default {
  async fetch(_request: Request, env: { IDS: DurableObjectNamespace<Id>; REQUESTS: DurableObjectNamespace<Requests> }) {
    return new Response((await env.IDS.getByName("x").hello()) + " " + (await env.REQUESTS.getByName("x").hello()));
  },
};
`,
    );
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    expect(await inPreview(workspace.id, "/")).toBe("id request");
  });

  it("gives app code its own slot's instances and nothing more", async () => {
    const workspace = await create("Data Contained");
    await save(workspace.id, "wrangler.jsonc", wrangler());
    await save(
      workspace.id,
      "src/index.ts",
      `import { env } from "cloudflare:workers";
export { Counter } from "./counter";
export default {
  async fetch() {
    // What the platform puts in env for the binding, reached from outside it.
    const data = (env as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>).__jigworks_app_data!;
    const tries = await Promise.all(
      [() => data.host!(), () => data.callFacet!("constructor", "a".repeat(64), "toString", [])].map((attempt) =>
        attempt().then(() => "reached", () => "refused"),
      ),
    );
    return new Response(tries.join(" "));
  },
};
`,
    );
    await save(workspace.id, "src/counter.ts", counterApp().replace(/export default \{[^]*$/, ""));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    expect(await inPreview(workspace.id, "/")).toBe("refused refused");
  });

  it("keeps the Preview's data apart from the Deployment's", async () => {
    const workspace = await counterWorkspace("Data Apart");
    expect(await inPreview(workspace.id, "/increment")).toBe("1");
    expect(await inPreview(workspace.id, "/increment")).toBe("2");
    const { url } = await publish(workspace.id, null);
    expect(await inDeployment(url, "/increment")).toBe("1");
    expect(await inPreview(workspace.id, "/increment")).toBe("3");
    expect(await inDeployment(url, "/read")).toBe("1");
  });

  it("keeps the Preview's data across a new Build, and the Deployment's across a new publish, running the new code", async () => {
    const workspace = await counterWorkspace("Data Kept");
    const first = await publish(workspace.id, null);
    expect(await inPreview(workspace.id, "/increment")).toBe("1");
    expect(await inDeployment(first.url, "/increment")).toBe("1");

    await save(workspace.id, "src/index.ts", counterApp("v2:"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    expect(await inPreview(workspace.id, "/increment")).toBe("v2:2");
    // Not published yet: the Deployment runs the old code, with its own data.
    expect(await inDeployment(first.url, "/increment")).toBe("2");

    await publish(workspace.id, first.hash);
    expect(await inDeployment(first.url, "/increment")).toBe("v2:3");
  });

  // workerd's facets have no alarm scheduler (#107, docs/findings.md). If this
  // starts failing, facets may have alarms: recheck them in the Preview, the
  // Deployment and after a new Build, and revisit ADRs 0015 and 0021. Deployed,
  // the first call fails the same way but keeps its writes and the time. The
  // app host keeps apps' alarms in place of workerd's own (ADR 0021), so the
  // app reaches workerd's methods through the storage's prototype.
  it("can't set an alarm in an instance: the call fails, and takes its writes with it", async () => {
    const workspace = await create("Data Alarms");
    await save(workspace.id, "wrangler.jsonc", wrangler({ durable_objects: { bindings: [{ name: "NOTES", class_name: "Notes" }] } }));
    await save(
      workspace.id,
      "src/index.ts",
      `import { DurableObject } from "cloudflare:workers";
export class Notes extends DurableObject {
  table() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT)");
  }
  async remindLater() {
    this.table();
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES ('written before setAlarm')");
    try {
      await Object.getPrototypeOf(this.ctx.storage).setAlarm.call(this.ctx.storage, Date.now() + 60_000);
      return "set";
    } catch (error) {
      return "caught: " + String(error);
    }
  }
  async state() {
    this.table();
    const rows = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").one().n;
    return { rows, alarm: await Object.getPrototypeOf(this.ctx.storage).getAlarm.call(this.ctx.storage) };
  }
  override async alarm() {}
}
export default {
  async fetch(request: Request, env: { NOTES: DurableObjectNamespace<Notes> }) {
    const notes = env.NOTES.getByName("a");
    if (new URL(request.url).pathname === "/remind") return new Response(await notes.remindLater());
    return Response.json(await notes.state());
  },
};
`,
    );
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    // The refusal comes as the write commits, so the app's own catch never sees it.
    // requestPreview rather than inPreview, for the status.
    const reminded = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/remind" });
    expect(reminded).toMatchObject({ status: 500, body: expect.stringContaining("Facets currently cannot set alarms.") });
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rows: 0, alarm: null });
  });

  // The stand-in sends fetch over RPC, which can't carry a WebSocket (#109,
  // docs/findings.md). If this starts failing, an upgrade may reach the app:
  // recheck hibernation and new Builds, and revisit ADR 0015.
  it("can't pass a WebSocket from an instance back to the app", async () => {
    const workspace = await create("Data Sockets");
    await save(workspace.id, "wrangler.jsonc", wrangler({ durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] } }));
    await save(
      workspace.id,
      "src/index.ts",
      `import { DurableObject } from "cloudflare:workers";
export class Room extends DurableObject {
  sockets() {
    return this.ctx.getWebSockets().length;
  }
  override async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
}
export default {
  async fetch(request: Request, env: { ROOM: DurableObjectNamespace<Room> }) {
    const room = env.ROOM.getByName("a");
    return request.headers.has("Upgrade") ? room.fetch(request) : new Response(String(await room.sockets()));
  },
};
`,
    );
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    // requestPreview rather than inPreview, for the status and the Upgrade header.
    const answer = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/", headers: { Upgrade: "websocket" } });
    expect(answer).toMatchObject({
      status: 500,
      body: expect.stringContaining('DataCloneError: Could not serialize object of type "WebSocket"'),
    });
    // The instance still holds the socket it accepted, which nobody can reach.
    expect(await inPreview(workspace.id, "/")).toBe("1");
  });

  it("goes with its Workspace", async () => {
    const workspace = await counterWorkspace("Data Deleted");
    expect(await inPreview(workspace.id, "/increment")).toBe("1");
    expect(await inPreview(workspace.id, "/increment")).toBe("2");
    const label = await env.WORKSPACES.getByName(workspace.id).appLabel();
    const deleted = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: workspace.name } });
    expect(deleted.status).toBe(204);

    // Should the label ever be given out again, nothing of the old app is left.
    const again = await create("Data Again");
    await runInDurableObject(env.WORKSPACES.getByName(again.id), (_instance, state) => {
      state.storage.kv.put("app:label", label);
      state.storage.kv.delete("app:sent");
    });
    await save(again.id, "wrangler.jsonc", wrangler());
    await save(again.id, "src/index.ts", counterApp());
    expect(await build(again.id)).toMatchObject({ ok: true });
    expect(await env.WORKSPACES.getByName(again.id).appLabel()).toBe(label);
    expect(await inPreview(again.id, "/read")).toBe("0");
  });
});

/**
 * An app whose Pinger instances record each ring of their alarm: the code's
 * `version`, the alarm's info, and what getAlarm() read during alarm().
 */
const alarmApp = (version = "v1", { broken = false, quick = false } = {}) => `import { DurableObject } from "cloudflare:workers";

export class Pinger extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    if (${broken}) throw new Error("the instance broke");
  }

  private rings() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rings (version TEXT NOT NULL, info TEXT NOT NULL, during INTEGER)");
    return this.ctx.storage.sql.exec("SELECT version, info, during FROM rings").toArray();
  }

  async set(ms: number, repeat: number, every: number, fail: string | null, slow: number, cheat = false, remove = false, later = false) {
    this.ctx.storage.kv.put("cheat", cheat);
    this.ctx.storage.kv.put("remove", remove);
    this.ctx.storage.kv.put("later", later);
    this.ctx.storage.kv.put("repeat", repeat);
    this.ctx.storage.kv.put("every", every);
    this.ctx.storage.kv.put("fail", fail);
    this.ctx.storage.kv.put("slow", slow);
    await this.ctx.storage.setAlarm(new Date(Date.now() + ms));
    return this.ctx.storage.getAlarm();
  }

  async setThenFail(ms: number) {
    try {
      await this.ctx.storage.transaction(async () => {
        await this.ctx.storage.setAlarm(Date.now() + ms);
        throw new Error("failed after setAlarm");
      });
    } catch (error) {
      return String(error);
    }
  }

  // Storage calls without await, which Cloudflare applies in the order they were made.
  async unawaited(ms: number) {
    const storage = this.ctx.storage;
    const set = storage.setAlarm(Date.now() + ms);
    const read = await storage.getAlarm();
    await storage.deleteAlarm();
    await set;
    const later = storage.setAlarm(Date.now() + 3_600_000);
    const sooner = storage.setAlarm(Date.now() + ms);
    await Promise.all([later, sooner]);
    return { read, set: await storage.getAlarm() };
  }

  // Makes the alarm due now, as if its time had come, straight in the platform's own table.
  async due() {
    this.ctx.storage.sql.exec("UPDATE __jigworks_alarm SET at = ?", Date.now());
  }

  // The alarm as the platform kept it before retries (#146), due now.
  async old() {
    this.ctx.storage.sql.exec("DROP TABLE __jigworks_alarm");
    this.ctx.storage.sql.exec("CREATE TABLE __jigworks_alarm (at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO __jigworks_alarm (at) VALUES (?)", Date.now());
  }

  async remove() {
    await this.ctx.storage.deleteAlarm();
  }

  async wipe() {
    await this.ctx.storage.deleteAll();
  }

  async state() {
    return { rings: this.rings(), alarm: await this.ctx.storage.getAlarm() };
  }

  async facet() {
    const storage = this.ctx.storage;
    return { props: this.ctx.props, own: storage.setAlarm !== Object.getPrototypeOf(storage).setAlarm };
  }

  override async alarm(info: AlarmInvocationInfo) {
    const during = await this.ctx.storage.getAlarm();
    const rang = this.rings().length;
    this.ctx.storage.sql.exec("INSERT INTO rings VALUES (?, ?, ?)", ${JSON.stringify(version)}, JSON.stringify(info), during);
    // A repeating alarm sets the next.
    if (rang < (this.ctx.storage.kv.get<number>("repeat") ?? 0)) await this.ctx.storage.setAlarm(Date.now() + (this.ctx.storage.kv.get<number>("every") ?? 200));
    if (this.ctx.storage.kv.get("remove")) await this.ctx.storage.deleteAlarm();
    const slow = ${quick} ? 0 : (this.ctx.storage.kv.get<number>("slow") ?? 0);
    if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
    // Sets the next without await.
    if (this.ctx.storage.kv.get("later")) void this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    const fail = this.ctx.storage.kv.get<string | null>("fail");
    // A value that can't be made into text, or an Error.
    if (fail === "odd") throw Object.create(null);
    if (fail !== null && fail !== undefined) throw new Error("the alarm broke");
    // Past setAlarm, straight into the platform's own table.
    if (this.ctx.storage.kv.get("cheat")) this.ctx.storage.sql.exec("INSERT INTO __jigworks_alarm (at) VALUES (?)", Date.now());
  }
}

export default {
  async fetch(request: Request, env: { PINGER: DurableObjectNamespace<Pinger> }): Promise<Response> {
    const url = new URL(request.url);
    const pinger = env.PINGER.getByName(url.searchParams.get("name") ?? "a");
    const ms = Number(url.searchParams.get("ms") ?? 200);
    if (url.pathname === "/set") return Response.json(await pinger.set(ms, Number(url.searchParams.get("repeat") ?? 0), Number(url.searchParams.get("every") ?? 200), url.searchParams.get("fail"), Number(url.searchParams.get("slow") ?? 0), url.searchParams.has("cheat"), url.searchParams.has("remove"), url.searchParams.has("later")));
    if (url.pathname === "/unawaited") return Response.json(await pinger.unawaited(ms));
    if (url.pathname === "/fail") return Response.json(await pinger.setThenFail(ms));
    if (url.pathname === "/delete") return Response.json(await pinger.remove());
    if (url.pathname === "/due") return Response.json(await pinger.due());
    if (url.pathname === "/old") return Response.json(await pinger.old());
    if (url.pathname === "/wipe") return Response.json(await pinger.wipe());
    if (url.pathname === "/facet") return Response.json(await pinger.facet());
    if (url.pathname === "/ring-itself") {
      const ring = (pinger as unknown as Record<string, () => Promise<unknown>>).__jigworks_ring!;
      return Response.json(await ring().then(() => "rang", (error) => String(error)));
    }
    return Response.json(await pinger.state());
  },
};
`;

interface PingerState {
  rings: { version: string; info: string; during: number | null }[];
  alarm: number | null;
}

const rang = (version: string, retryCount = 0) => ({ version, info: JSON.stringify({ retryCount, isRetry: retryCount > 0 }), during: null });

const alarmWorkspace = async (name: string) => {
  const workspace = await create(name);
  await save(workspace.id, "wrangler.jsonc", wrangler({ durable_objects: { bindings: [{ name: "PINGER", class_name: "Pinger" }] } }));
  await save(workspace.id, "src/index.ts", alarmApp());
  expect(await build(workspace.id)).toMatchObject({ ok: true });
  return workspace;
};

const appHostOf = async (id: string) => env.APP_HOSTS.getByName(await env.WORKSPACES.getByName(id).appLabel());

/** Waits until a Pinger has rung `times` times, reading it with `read`. */
const ringsOf = (read: () => Promise<string>, times = 1) =>
  waitFor(
    async () => JSON.parse(await read()) as PingerState,
    (state) => state.rings.length >= times,
  );

describe("an app's alarms (ADR 0021)", () => {
  it("relies on facets taking the platform's storage methods and props, and its own method ringing alarm()", async () => {
    const workspace = await alarmWorkspace("Alarms Facets");
    expect(JSON.parse(await inPreview(workspace.id, "/facet"))).toEqual({
      props: { binding: "PINGER", id: expect.stringMatching(/^[0-9a-f]{64}$/), name: "a" },
      own: true,
    });
    await inPreview(workspace.id, "/set?ms=100");
    expect((await ringsOf(() => inPreview(workspace.id, "/state"))).rings).toEqual([rang("v1")]);
    // Only the app host may wake an instance.
    expect(JSON.parse(await inPreview(workspace.id, "/ring-itself"))).toContain("does not implement the method");
  });

  it("rings in each slot with that slot's code and data, and not in the other", async () => {
    const workspace = await alarmWorkspace("Alarms Slots");
    const { url, hash } = await publish(workspace.id, null);
    await save(workspace.id, "src/index.ts", alarmApp("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });

    await inPreview(workspace.id, "/set?ms=100");
    await inDeployment(url, "/set?ms=300");
    expect(await ringsOf(() => inDeployment(url, "/state"))).toEqual({ rings: [rang("v1")], alarm: null });
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v2")], alarm: null });

    // Publishing doesn't copy the Preview's alarms.
    await inPreview(workspace.id, "/set?name=b&ms=300");
    await publish(workspace.id, hash);
    expect(JSON.parse(await inDeployment(url, "/state?name=b"))).toEqual({ rings: [], alarm: null });
    expect((await ringsOf(() => inPreview(workspace.id, "/state?name=b"))).rings).toEqual([rang("v2")]);
    await inDeployment(url, "/set?name=c&ms=100");
    await ringsOf(() => inDeployment(url, "/state?name=c"));
    expect(JSON.parse(await inDeployment(url, "/state?name=b"))).toEqual({ rings: [], alarm: null });
  });

  it("rings with the new code when a new Build or a publish comes before it", async () => {
    const workspace = await alarmWorkspace("Alarms New Code");
    const first = await publish(workspace.id, null);
    const host = await appHostOf(workspace.id);
    const setAt = Date.now();
    await inPreview(workspace.id, "/set?ms=1000");
    await inDeployment(first.url, "/set?ms=1000");
    // Held off, so the alarms can't ring before the new code is in.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));

    await save(workspace.id, "src/index.ts", alarmApp("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await publish(workspace.id, first.hash);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, setAt + 1_100 - Date.now())));
    expect(await runDurableObjectAlarm(host)).toBe(true);

    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v2")], alarm: null });
    expect(JSON.parse(await inDeployment(first.url, "/state"))).toEqual({ rings: [rang("v2")], alarm: null });
  });

  it("reads the time while pending and null during alarm() and once rung, and keeps the next alarm that alarm() sets", async () => {
    const workspace = await alarmWorkspace("Alarms Next");
    const before = Date.now();
    const at = JSON.parse(await inPreview(workspace.id, "/set?ms=200&repeat=1")) as number;
    expect(at).toBeGreaterThanOrEqual(before + 200);
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [], alarm: at });

    const state = await ringsOf(() => inPreview(workspace.id, "/state"), 2);
    expect(state).toEqual({ rings: [rang("v1"), rang("v1")], alarm: null });
  });

  it("wakes next for the alarm that alarm() sets, not again at once", async () => {
    const workspace = await alarmWorkspace("Alarms Wake Once");
    const host = await appHostOf(workspace.id);
    const setAt = Date.now();
    await inPreview(workspace.id, "/set?ms=1000&repeat=1&every=60000");
    // Held off, so only the pool's helper runs it.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, setAt + 1_100 - Date.now())));
    expect(await runDurableObjectAlarm(host)).toBe(true);
    expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeGreaterThan(Date.now() + 30_000);
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v1")], alarm: expect.any(Number) });
  });

  it("doesn't ring after deleteAlarm(), or a call that failed after setAlarm()", async () => {
    const workspace = await alarmWorkspace("Alarms Cancelled");
    await inPreview(workspace.id, "/set?name=deleted&ms=100");
    await inPreview(workspace.id, "/delete?name=deleted");
    expect(JSON.parse(await inPreview(workspace.id, "/fail?name=failed&ms=100"))).toBe("Error: failed after setAlarm");
    // Due after the others, so once it has rung, they've had their chance.
    await inPreview(workspace.id, "/set?name=kept&ms=400");
    expect((await ringsOf(() => inPreview(workspace.id, "/state?name=kept"))).rings).toEqual([rang("v1")]);
    for (const name of ["deleted", "failed"]) {
      expect(JSON.parse(await inPreview(workspace.id, `/state?name=${name}`))).toEqual({ rings: [], alarm: null });
    }
  });

  it("keeps an earlier alarm when a later one's call fails", async () => {
    const workspace = await alarmWorkspace("Alarms Kept");
    await inPreview(workspace.id, "/set?ms=300");
    expect(JSON.parse(await inPreview(workspace.id, "/fail?ms=3600000"))).toBe("Error: failed after setAlarm");
    expect((await ringsOf(() => inPreview(workspace.id, "/state"))).rings).toEqual([rang("v1")]);
  });

  it("keeps a due alarm that hasn't rung yet when a later one's call fails", async () => {
    const workspace = await alarmWorkspace("Alarms Kept Due");
    const host = await appHostOf(workspace.id);
    const setAt = Date.now();
    await inPreview(workspace.id, "/set?ms=1000");
    // Held off, so the alarm is due before the app host wakes it.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, setAt + 1_100 - Date.now())));
    expect(JSON.parse(await inPreview(workspace.id, "/fail?ms=86400000"))).toBe("Error: failed after setAlarm");
    // The app host's alarm is set for the due alarm again, so it may ring by itself first.
    await runDurableObjectAlarm(host);
    expect(await ringsOf(() => inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v1")], alarm: null });
  });

  it("keeps the order of storage calls made without await", async () => {
    const workspace = await alarmWorkspace("Alarms Unawaited");
    const { read, set } = JSON.parse(await inPreview(workspace.id, "/unawaited?ms=200")) as { read: number; set: number };
    expect(read).toBeGreaterThan(Date.now() - 5_000);
    // The last setAlarm stands, and the deleteAlarm in between took the first.
    expect(set).toBeLessThan(Date.now() + 60_000);
    const state = await ringsOf(() => inPreview(workspace.id, "/state"));
    expect(state).toEqual({ rings: [rang("v1")], alarm: null });
  });

  it("takes an alarm too far ahead for an alarm of the app host's own", async () => {
    const workspace = await alarmWorkspace("Alarms Far");
    const far = Date.now() + 1e15;
    expect(JSON.parse(await inPreview(workspace.id, "/set?ms=1e15"))).toBeGreaterThanOrEqual(far);
    const host = await appHostOf(workspace.id);
    expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeLessThanOrEqual(Date.now() + 366 * 24 * 60 * 60 * 1000);
    // Secrets still work, which set the app host's alarm too.
    expect((await call(`/api/workspaces/${workspace.id}/secrets/API_KEY`, { method: "PUT", body: { value: "a-secret-value" } })).status).toBe(204);
  });

  it("wakes an instance again that couldn't answer, until it can", async () => {
    const workspace = await alarmWorkspace("Alarms Unanswered");
    const host = await appHostOf(workspace.id);
    const setAt = Date.now();
    await inPreview(workspace.id, "/set?ms=1000");
    // Held off, so the alarm rings only once the code is broken.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await save(workspace.id, "src/index.ts", alarmApp("v2", { broken: true }));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, setAt + 1_100 - Date.now())));
    expect(await runDurableObjectAlarm(host)).toBe(true);
    const logs = await env.WORKSPACES.getByName(workspace.id).previewLogs();
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "exception", message: "The alarm of PINGER couldn't ring: Error: the instance broke. It will be woken again in 1 second." }),
    );

    await save(workspace.id, "src/index.ts", alarmApp("v3"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    // A minute on.
    await runInDurableObject(host, (_instance, state) => {
      state.storage.sql.exec("UPDATE alarms SET at = at - 60000");
    });
    expect(await runDurableObjectAlarm(host)).toBe(true);
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v3")], alarm: null });
  });

  it("writes nothing more once its Workspace is deleted during a ring", async () => {
    const workspace = await alarmWorkspace("Alarms Deleted Midway");
    const host = await appHostOf(workspace.id);
    await inPreview(workspace.id, "/set?ms=100&slow=1000");
    await inPreview(workspace.id, "/set?name=b&ms=100");
    // alarm() has started, and waits a second before it ends.
    await ringsOf(() => inPreview(workspace.id, "/state"));
    const deleted = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: workspace.name } });
    expect(deleted.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      await runInDurableObject(host, (_instance, state) => ({
        tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray(),
        keys: [...state.storage.kv.list()],
      })),
    ).toEqual({ tables: [], keys: [] });
    expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("retries a failing alarm() with isRetry and backoff, then drops it after 6 retries, saying so in the slot's logs", async () => {
    const workspace = await alarmWorkspace("Alarms Retried");
    const host = await appHostOf(workspace.id);
    const holdOff = () => runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await inPreview(workspace.id, "/set?ms=0&fail");
    await holdOff();
    for (let retryCount = 0; retryCount <= 6; retryCount++) {
      // Its time has come: the instance's own alarm and the app host's row.
      await inPreview(workspace.id, "/due");
      await runInDurableObject(host, (_instance, state) => {
        state.storage.sql.exec("UPDATE alarms SET at = 0");
      });
      const before = Date.now();
      expect(await runDurableObjectAlarm(host)).toBe(true);
      const after = Date.now();
      await holdOff();
      const { rings, alarm } = JSON.parse(await inPreview(workspace.id, "/state")) as PingerState;
      expect(rings).toEqual(Array.from({ length: retryCount + 1 }, (_, count) => rang("v1", count)));
      if (retryCount === 6) expect(alarm).toBeNull();
      else {
        // A minimum interval, a second in the tests, then twice as long each time.
        expect(alarm).toBeGreaterThanOrEqual(before + 1_000 * 2 ** retryCount);
        expect(alarm).toBeLessThanOrEqual(after + 1_000 * 2 ** retryCount);
      }
    }
    const messages = (await env.WORKSPACES.getByName(workspace.id).previewLogs()).filter(({ level }) => level === "exception").map(({ message }) => message);
    expect(messages).toEqual([
      "The alarm of PINGER threw Error: the alarm broke. Retry 1 of 6 in 1 second.",
      "The alarm of PINGER (retry 1 of 6) threw Error: the alarm broke. Retry 2 of 6 in 2 seconds.",
      "The alarm of PINGER (retry 2 of 6) threw Error: the alarm broke. Retry 3 of 6 in 4 seconds.",
      "The alarm of PINGER (retry 3 of 6) threw Error: the alarm broke. Retry 4 of 6 in 8 seconds.",
      "The alarm of PINGER (retry 4 of 6) threw Error: the alarm broke. Retry 5 of 6 in 16 seconds.",
      "The alarm of PINGER (retry 5 of 6) threw Error: the alarm broke. Retry 6 of 6 in 32 seconds.",
      "The alarm of PINGER (retry 6 of 6) threw Error: the alarm broke. It was dropped after 6 retries.",
    ]);
    // Dropped, so nothing wakes it again.
    expect(await runDurableObjectAlarm(host)).toBe(true);
    expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("retries an alarm() that throws a value that can't be shown as text", async () => {
    const workspace = await alarmWorkspace("Alarms Odd Throw");
    await inPreview(workspace.id, "/set?ms=0&fail=odd");
    const logs = await waitFor(
      () => env.WORKSPACES.getByName(workspace.id).previewLogs(),
      (lines) => lines.some(({ level }) => level === "exception"),
    );
    expect(logs.find(({ level }) => level === "exception")?.message).toBe("The alarm of PINGER threw a value that can't be shown as text. Retry 1 of 6 in 1 second.");
  });

  it("doesn't retry an alarm() that throws after setting the next, or deleting its alarm", async () => {
    const workspace = await alarmWorkspace("Alarms Not Retried");
    await inPreview(workspace.id, "/set?name=next&ms=0&fail&repeat=1&every=3600000");
    await inPreview(workspace.id, "/set?name=removed&ms=0&fail&remove");
    await inPreview(workspace.id, "/set?name=unawaited&ms=0&fail&later");
    const logs = await waitFor(
      () => env.WORKSPACES.getByName(workspace.id).previewLogs(),
      (lines) => lines.filter(({ level }) => level === "exception").length === 3,
    );
    expect(logs.filter(({ level }) => level === "exception").map(({ message }) => message)).toEqual([
      "The alarm of PINGER threw Error: the alarm broke. It isn't retried, as alarm() set or deleted its alarm.",
      "The alarm of PINGER threw Error: the alarm broke. It isn't retried, as alarm() set or deleted its alarm.",
      "The alarm of PINGER threw Error: the alarm broke. It isn't retried, as alarm() set or deleted its alarm.",
    ]);
    // The next alarms stand, an hour on, and the deleted one is gone.
    for (const name of ["next", "unawaited"]) {
      const next = JSON.parse(await inPreview(workspace.id, `/state?name=${name}`)) as PingerState;
      expect(next).toEqual({ rings: [rang("v1")], alarm: expect.any(Number) });
      expect(next.alarm).toBeGreaterThan(Date.now() + 3_000_000);
    }
    expect(JSON.parse(await inPreview(workspace.id, "/state?name=removed"))).toEqual({ rings: [rang("v1")], alarm: null });
  });

  it("rings an alarm again, as a retry, when a new Build cuts its ring off", async () => {
    const workspace = await alarmWorkspace("Alarms Cut Off");
    const host = await appHostOf(workspace.id);
    await inPreview(workspace.id, "/set?ms=0&slow=20000");
    // alarm() has started, and is still running.
    await ringsOf(() => inPreview(workspace.id, "/state"));
    await save(workspace.id, "src/index.ts", alarmApp("v2", { quick: true }));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    const logs = await waitFor(
      () => env.WORKSPACES.getByName(workspace.id).previewLogs(),
      (lines) => lines.some(({ message }) => message.includes("couldn't ring")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "exception", message: "The alarm of PINGER couldn't ring: Error: The app has new code or secrets. It will be woken again in 1 second." }),
    );
    // A minimum interval on.
    expect(await ringsOf(() => inPreview(workspace.id, "/state"), 2)).toEqual({ rings: [rang("v1"), rang("v2", 1)], alarm: null });
  });

  it("rings an alarm again, as a retry, when its app host stops mid-ring", async () => {
    const workspace = await alarmWorkspace("Alarms Host Stopped");
    const host = await appHostOf(workspace.id);
    const at = JSON.parse(await inPreview(workspace.id, "/set?ms=0&slow=20000")) as number;
    // Held off, so the pool's helper runs the wake, and the stop ends it there.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, at + 100 - Date.now())));
    const wake = runDurableObjectAlarm(host).catch(() => "stopped");
    await ringsOf(() => inPreview(workspace.id, "/state"));
    await runInDurableObject(host, (_instance, state) => state.abort("stopped mid-ring")).catch(() => {});
    expect(await wake).toBe("stopped");
    // Started again, by a request, with the new code so the retry isn't slow.
    await save(workspace.id, "src/index.ts", alarmApp("v2", { quick: true }));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    // The row was never answered, so it's still due when the app host's alarm
    // runs again, as Cloudflare runs an alarm that was cut off. A stub to the
    // stopped app host is broken, so a new one.
    const restarted = await appHostOf(workspace.id);
    await runInDurableObject(restarted, (_instance, state) => state.storage.setAlarm(Date.now()));
    expect((await ringsOf(() => inPreview(workspace.id, "/state"), 2))).toEqual({ rings: [rang("v1"), rang("v2", 1)], alarm: null });
  });

  it("drops the alarm of an instance that couldn't answer its wake or its 6 retries", async () => {
    const workspace = await alarmWorkspace("Alarms Never Answered");
    const host = await appHostOf(workspace.id);
    await inPreview(workspace.id, "/set?ms=3600000");
    await save(workspace.id, "src/index.ts", alarmApp("v2", { broken: true }));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    const logged = vi.spyOn(console, "log");
    try {
      for (let wake = 0; wake <= 6; wake++) {
        await runInDurableObject(host, (_instance, state) => {
          state.storage.sql.exec("UPDATE alarms SET at = 0");
        });
        expect(await runDurableObjectAlarm(host)).toBe(true);
        // Held off, so only the pool's helper runs it.
        if (wake < 6) await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
      }
      const records = logged.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"event":"alarm"'))
        .map((line) => JSON.parse(line) as { outcome: string; retryCount: number | null });
      expect(records.map(({ outcome, retryCount }) => [outcome, retryCount])).toEqual([
        ...[0, 1, 2, 3, 4, 5].map((count) => ["unanswered", count]),
        ["dropped", 6],
      ]);
    } finally {
      logged.mockRestore();
    }
    const messages = (await env.WORKSPACES.getByName(workspace.id).previewLogs()).map(({ message }) => message).filter((message) => message.includes("couldn't ring"));
    expect(messages).toEqual([
      ...[1, 2, 4, 8, 16, 32].map((seconds) => `The alarm of PINGER couldn't ring: Error: the instance broke. It will be woken again in ${seconds} second${seconds === 1 ? "" : "s"}.`),
      "The alarm of PINGER couldn't ring: Error: the instance broke. It was dropped after 6 retries.",
    ]);
    expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("doesn't let a failing alarm() hold up other instances' alarms or the clean-up of retired secrets", async () => {
    const workspace = await alarmWorkspace("Alarms Failing Alongside");
    const host = await appHostOf(workspace.id);
    const setSecret = (value: string) => call(`/api/workspaces/${workspace.id}/secrets/API_KEY`, { method: "PUT", body: { value } });
    expect((await setSecret("the-old-value")).status).toBe(204);
    expect((await setSecret("the-new-value")).status).toBe(204);
    await runInDurableObject(host, (_instance, state) => {
      state.storage.sql.exec("UPDATE retired_secrets SET retired_at = retired_at - 3600001");
    });
    await inPreview(workspace.id, "/set?name=failing&ms=0&fail");
    await inPreview(workspace.id, "/set?name=other&ms=0");
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await runDurableObjectAlarm(host)).toBe(true);

    expect(JSON.parse(await inPreview(workspace.id, "/state?name=other"))).toEqual({ rings: [rang("v1")], alarm: null });
    const failing = JSON.parse(await inPreview(workspace.id, "/state?name=failing")) as PingerState;
    expect(failing).toEqual({ rings: [rang("v1")], alarm: expect.any(Number) });
    expect(await runInDurableObject(host, (_instance, state) => state.storage.sql.exec("SELECT * FROM retired_secrets").toArray())).toEqual([]);
    // The app host wakes next for the retry, a second on.
    expect(await runInDurableObject(host, (_instance, state) => state.storage.getAlarm())).toBeLessThanOrEqual(failing.alarm!);
  });

  it("logs each ring in the slot's logs and the platform's, with its outcome, retry count and duration, but not the instance's name", async () => {
    const workspace = await alarmWorkspace("Alarms Logged");
    const logged = vi.spyOn(console, "log");
    try {
      await inPreview(workspace.id, "/set?name=jo.bloggs@example.com&ms=0");
      await ringsOf(() => inPreview(workspace.id, "/state?name=jo.bloggs@example.com"));
      const logs = await waitFor(
        () => env.WORKSPACES.getByName(workspace.id).previewLogs(),
        (lines) => lines.some(({ message }) => message.includes("rang")),
      );
      expect(logs).toContainEqual(expect.objectContaining({ level: "info", message: expect.stringMatching(/^The alarm of PINGER rang in \d+ ms\.$/) }));
      const lines = logged.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"event":"alarm"'));
      expect(lines.map((line) => JSON.parse(line))).toContainEqual({
        event: "alarm",
        workspace: workspace.id,
        slot: "preview",
        binding: "PINGER",
        outcome: "rang",
        retryCount: 0,
        durationMs: expect.any(Number),
      });
      for (const line of [...lines, ...logs.map(({ message }) => message)]) expect(line).not.toContain("bloggs");
    } finally {
      logged.mockRestore();
    }
  });

  it("rings an alarm kept before retries, in an app host from before them", async () => {
    const workspace = await alarmWorkspace("Alarms From Before");
    const host = await appHostOf(workspace.id);
    await inPreview(workspace.id, "/set?ms=3600000");
    await inPreview(workspace.id, "/old");
    await runInDurableObject(host, (instance, state) => {
      state.storage.sql.exec("ALTER TABLE alarms DROP COLUMN misses");
      state.storage.sql.exec("UPDATE alarms SET at = 0");
      // As if the app host had just started.
      (instance as unknown as { tablesReady: boolean }).tablesReady = false;
    });
    expect(await runDurableObjectAlarm(host)).toBe(true);
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v1")], alarm: null });
  });

  // workerd refuses deleteAll() in a facet ("expected parent == kj::none"), and
  // the instance's database is broken until it restarts. The alarm is a table
  // in that database, so deleteAll() would take it, as on Cloudflare. If this
  // starts failing, facets may have deleteAll(): add it to the test above.
  it("can't deleteAll() in an instance", async () => {
    const workspace = await alarmWorkspace("Alarms Wiped");
    const wiped = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/wipe" });
    expect(wiped).toMatchObject({ status: 500, body: expect.stringContaining("internal error") });
  });

  it("wakes for the earliest of its alarms and its retired secrets, and does both", async () => {
    const workspace = await alarmWorkspace("Alarms Secrets");
    const host = await appHostOf(workspace.id);
    const hostAlarm = () => runInDurableObject(host, (_instance, state) => state.storage.getAlarm());
    await inPreview(workspace.id, "/set?name=later&ms=7200000");
    const setSecret = (value: string) => call(`/api/workspaces/${workspace.id}/secrets/API_KEY`, { method: "PUT", body: { value } });
    expect((await setSecret("the-old-value")).status).toBe(204);
    expect((await setSecret("the-new-value")).status).toBe(204);
    // A replaced secret is forgotten in an hour, before the alarm two hours away.
    expect(await hostAlarm()).toBeLessThanOrEqual(Date.now() + 3_600_000);

    // An hour on, with an alarm due too: one wake rings it and forgets the value.
    await runInDurableObject(host, (_instance, state) => {
      state.storage.sql.exec("UPDATE retired_secrets SET retired_at = retired_at - 3600001");
    });
    await inPreview(workspace.id, "/set?name=soon&ms=100");
    expect((await ringsOf(() => inPreview(workspace.id, "/state?name=soon"))).rings).toEqual([rang("v1")]);
    expect(await runInDurableObject(host, (_instance, state) => state.storage.sql.exec("SELECT * FROM retired_secrets").toArray())).toEqual([]);
    expect(await hostAlarm()).toBeGreaterThan(Date.now() + 3_600_000);
  });

  // The tests' limits are in vitest.config.ts: an interval of a second, 8
  // instances with alarms in each slot, and a deadline of 5 seconds a ring.
  it("rings an alarm set sooner than the minimum interval at the interval, and reads that time", async () => {
    const workspace = await alarmWorkspace("Alarms Interval");
    const before = Date.now();
    const at = JSON.parse(await inPreview(workspace.id, "/set?ms=-60000")) as number;
    const after = Date.now();
    expect(at).toBeGreaterThanOrEqual(before + 1_000);
    expect(at).toBeLessThanOrEqual(after + 1_000);
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [], alarm: at });
    expect(await ringsOf(() => inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v1")], alarm: null });
  });

  it("refuses setAlarm() past the slot's most instances with alarms, saying why, and writes nothing", async () => {
    const workspace = await alarmWorkspace("Alarms Cap");
    const { url } = await publish(workspace.id, null);
    for (let n = 1; n <= 8; n++) await inPreview(workspace.id, `/set?name=${n}&ms=3600000`);
    const refused = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/set?name=9&ms=3600000" });
    expect(refused).toMatchObject({
      status: 500,
      body: expect.stringContaining(
        "The Preview already has alarms set in 8 Durable Object instances, the most it can have, so setAlarm() can't set another. Set alarms in fewer instances, such as one that keeps a list of times and sets its alarm for the next.",
      ),
    });
    expect(JSON.parse(await inPreview(workspace.id, "/state?name=9"))).toEqual({ rings: [], alarm: null });

    // An instance with an alarm can still move it, and the Deployment has its own.
    await inPreview(workspace.id, "/set?name=1&ms=7200000");
    expect(JSON.parse(await inDeployment(url, "/set?name=9&ms=3600000"))).toEqual(expect.any(Number));
    // Once one is deleted, another instance may set one, within the interval.
    await inPreview(workspace.id, "/delete?name=2");
    const set = await waitFor(
      () => env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/set?name=9&ms=3600000" }),
      ({ status }) => status === 200,
    );
    expect(set.status).toBe(200);
  });

  it("holds an instance that writes its alarm itself to the interval too", async () => {
    const workspace = await alarmWorkspace("Alarms Written Past");
    await inPreview(workspace.id, "/set?ms=0&cheat");
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    // At 1, 2 and 3 seconds, not as often as the app host can wake it.
    const { rings } = JSON.parse(await inPreview(workspace.id, "/state")) as PingerState;
    expect(rings.length).toBeGreaterThanOrEqual(2);
    expect(rings.length).toBeLessThanOrEqual(4);
  });

  it("rings due alarms a few at a time, so one slow alarm() doesn't hold up the rest past its deadline", async () => {
    const workspace = await alarmWorkspace("Alarms Backlog");
    const host = await appHostOf(workspace.id);
    // Due first, and slower than the deadline.
    await inPreview(workspace.id, "/set?name=stuck&ms=3000&slow=20000");
    const names = ["1", "2", "3", "4", "5", "6", "7"];
    const due = await Promise.all(names.map(async (name) => JSON.parse(await inPreview(workspace.id, `/set?name=${name}&ms=3000&slow=1000`)) as number));
    // Held off, so only the pool's helper runs it, once all are due.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.max(...due) + 100 - Date.now())));

    const started = Date.now();
    expect(await runDurableObjectAlarm(host)).toBe(true);
    // One at a time, the 7 would take 7 seconds after the stuck one's 5.
    expect(Date.now() - started).toBeLessThan(8_000);
    for (const name of names) expect(JSON.parse(await inPreview(workspace.id, `/state?name=${name}`))).toEqual({ rings: [rang("v1")], alarm: null });
    const logs = await env.WORKSPACES.getByName(workspace.id).previewLogs();
    expect(logs).toContainEqual(expect.objectContaining({ level: "exception", message: "The alarm of PINGER didn't finish within 5 seconds." }));
  });

  it("waits on for a ring past its deadline, without ringing it again, and logs how it ended", async () => {
    const workspace = await alarmWorkspace("Alarms Late");
    const host = await appHostOf(workspace.id);
    const at = JSON.parse(await inPreview(workspace.id, "/set?ms=0&slow=8000&fail")) as number;
    // Held off, so only the pool's helper runs it.
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, at + 100 - Date.now())));
    expect(await runDurableObjectAlarm(host)).toBe(true);
    // A minute on, while alarm() still runs.
    await runInDurableObject(host, (_instance, state) => {
      state.storage.sql.exec("UPDATE alarms SET at = at - 60000");
    });
    expect(await runDurableObjectAlarm(host)).toBe(true);
    const logs = await waitFor(
      () => env.WORKSPACES.getByName(workspace.id).previewLogs(),
      (lines) => lines.some(({ message }) => message.includes("threw")),
    );
    expect(logs).toContainEqual(expect.objectContaining({ level: "exception", message: "The alarm of PINGER didn't finish within 5 seconds." }));
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "exception", message: expect.stringMatching(/^The alarm of PINGER threw Error: the alarm broke\. Retry 1 of 6 in \d seconds?\.$/) }),
    );
    expect(JSON.parse(await inPreview(workspace.id, "/state"))).toEqual({ rings: [rang("v1")], alarm: expect.any(Number) });
  });

  it("doesn't ring an instance again while its alarm() runs on past the deadline, even once it has set the next", async () => {
    const workspace = await alarmWorkspace("Alarms Overlap");
    const host = await appHostOf(workspace.id);
    const at = JSON.parse(await inPreview(workspace.id, "/set?ms=0&repeat=1&every=0&slow=9000")) as number;
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, at + 100 - Date.now())));
    const started = Date.now();
    expect(await runDurableObjectAlarm(host)).toBe(true);
    // The next alarm, a second after the first rang, is due while the first still runs.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 7_500 - Date.now())));
    expect((JSON.parse(await inPreview(workspace.id, "/state")) as PingerState).rings).toHaveLength(1);
    // Once the first has ended, the next rings.
    expect((await ringsOf(() => inPreview(workspace.id, "/state"), 2)).rings).toHaveLength(2);
  });

  it("starts no ring once a wake has run for the deadline, and wakes again for the rest", async () => {
    const workspace = await alarmWorkspace("Alarms Long Wake");
    const host = await appHostOf(workspace.id);
    const names = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const due = await Promise.all(names.map(async (name) => JSON.parse(await inPreview(workspace.id, `/set?name=${name}&ms=3000&slow=12000`)) as number));
    await runInDurableObject(host, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.max(...due) + 100 - Date.now())));

    const started = Date.now();
    expect(await runDurableObjectAlarm(host)).toBe(true);
    // Ringing the last 3 after the first 5 would take another 5 seconds.
    expect(Date.now() - started).toBeLessThan(8_000);
    const rang = await waitFor(
      () => Promise.all(names.map(async (name) => (JSON.parse(await inPreview(workspace.id, `/state?name=${name}`)) as PingerState).rings.length)),
      (counts) => counts.every((count) => count === 1),
    );
    expect(rang).toEqual(names.map(() => 1));
  });

  it("goes with its Workspace", async () => {
    const workspace = await alarmWorkspace("Alarms Deleted");
    const host = await appHostOf(workspace.id);
    await inPreview(workspace.id, "/set?ms=3600000");
    const deleted = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: workspace.name } });
    expect(deleted.status).toBe(204);
    expect(await runDurableObjectAlarm(host)).toBe(false);
  });
});
