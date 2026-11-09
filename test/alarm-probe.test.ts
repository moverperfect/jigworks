import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BuildReport } from "../src/shared/build-report";
import type { Deployment } from "../src/shared/deployment";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";

// Throwaway probe for #107: does an app's Durable Object, as a facet, get alarms?

const build = async (id: string) => (await call(`/api/workspaces/${id}/build`, { method: "POST" })).json<BuildReport>();
const save = async (id: string, path: string, text: string) => {
  expect((await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text })).status).toBe(204);
};
const wrangler = JSON.stringify({
  name: "app",
  main: "src/index.ts",
  compatibility_date: "2026-10-01",
  durable_objects: { bindings: [{ name: "PINGER", class_name: "Pinger" }] },
});
const app = (version: string) => `import { DurableObject } from "cloudflare:workers";
export class Pinger extends DurableObject {
  private table() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rings (at INTEGER, version TEXT, info TEXT)");
  }
  async arm(ms: number) {
    this.table();
    try {
      await this.ctx.storage.setAlarm(Date.now() + ms);
      return { armed: await this.ctx.storage.getAlarm(), id: this.ctx.id.toString() };
    } catch (error) {
      return { error: String(error) };
    }
  }
  async writeThenArm() {
    this.table();
    this.ctx.storage.sql.exec("INSERT INTO rings VALUES (?, 'written-before-setAlarm', NULL)", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return "armed";
  }
  async record(cron: string) {
    this.table();
    this.ctx.storage.sql.exec("INSERT INTO rings VALUES (?, ?, ?)", Date.now(), ${JSON.stringify(version)}, cron);
  }
  async pending() {
    return await this.ctx.storage.getAlarm();
  }
  async rings() {
    this.table();
    return { rings: this.ctx.storage.sql.exec("SELECT * FROM rings").toArray(), pending: await this.ctx.storage.getAlarm() };
  }
  async alarm(info: unknown) {
    this.table();
    this.ctx.storage.sql.exec("INSERT INTO rings VALUES (?, ?, ?)", Date.now(), ${JSON.stringify(version)}, JSON.stringify(info ?? null));
    console.log("ring ${version}");
  }
}
export default {
  async scheduled(controller: ScheduledController, env: { PINGER: DurableObjectNamespace<Pinger> }) {
    console.log("scheduled ${version} " + controller.cron);
    await env.PINGER.getByName("a").record(controller.cron);
  },
  async fetch(request: Request, env: { PINGER: DurableObjectNamespace<Pinger> }) {
    const url = new URL(request.url);
    const pinger = env.PINGER.getByName(url.searchParams.get("name") ?? "a");
    if (url.pathname === "/arm") return Response.json(await pinger.arm(Number(url.searchParams.get("ms") ?? 200)));
    if (url.pathname === "/write-then-arm") return Response.json(await pinger.writeThenArm());
    if (url.pathname === "/get") return Response.json({ pending: await pinger.pending() });
    if (url.pathname === "/rings") return Response.json(await pinger.rings());
    return new Response("${version}");
  },
};
`;
const inPreview = async (id: string, path: string) => {
  const r = await env.WORKSPACES.getByName(id).requestPreview({ method: "GET", path });
  return { status: r.status, body: r.body };
};
const inDeployment = async (url: string, path: string) => {
  const token = await accessToken({ email: "colleague@example.com" }, { audience: testAccess.appsAudience });
  const r = await exports.default.fetch(new Request(new URL(path, url), { headers: { "Cf-Access-Jwt-Assertion": token } }));
  return { status: r.status, body: await r.text() };
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hostAlarm = async (id: string) => {
  const label = await env.WORKSPACES.getByName(id).appLabel();
  return runInDurableObject(env.APP_HOSTS.getByName(label), (_i, state) => state.storage.getAlarm());
};

describe("probe: alarms in an app's Durable Object", () => {
  it("in the Preview", async () => {
    const workspace = await create("Probe Preview");
    await save(workspace.id, "wrangler.jsonc", wrangler);
    await save(workspace.id, "src/index.ts", app("v1"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    console.log("PREVIEW getAlarm first", JSON.stringify(await inPreview(workspace.id, "/get")));
    console.log("PREVIEW rings first", JSON.stringify(await inPreview(workspace.id, "/rings")));
    const armed = await inPreview(workspace.id, "/arm?ms=300");
    console.log("PREVIEW armed", JSON.stringify(armed), "host alarm", await hostAlarm(workspace.id));
    await pause(2000);
    console.log("PREVIEW after 2s", JSON.stringify(await inPreview(workspace.id, "/rings")), "host alarm", await hostAlarm(workspace.id));
  });

  it("after a new Build aborts the facet", async () => {
    const workspace = await create("Probe Abort");
    await save(workspace.id, "wrangler.jsonc", wrangler);
    await save(workspace.id, "src/index.ts", app("v1"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    console.log("ABORT armed", JSON.stringify(await inPreview(workspace.id, "/arm?ms=1500")));
    await save(workspace.id, "src/index.ts", app("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await pause(3000);
    console.log("ABORT after new Build + 3s", JSON.stringify(await inPreview(workspace.id, "/rings")));
  });

  it("in the Deployment", async () => {
    const workspace = await create("Probe Deployment");
    await save(workspace.id, "wrangler.jsonc", wrangler);
    await save(workspace.id, "src/index.ts", app("v1"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    const response = await call(`/api/workspaces/${workspace.id}/deployment`, { method: "POST", body: { replaces: null } });
    const { url } = await response.json<Deployment>();
    console.log("DEPLOYMENT armed", JSON.stringify(await inDeployment(url, "/arm?ms=300")));
    await pause(2000);
    console.log("DEPLOYMENT after 2s", JSON.stringify(await inDeployment(url, "/rings")));
    console.log("PREVIEW same name", JSON.stringify(await inPreview(workspace.id, "/rings")));
  });

  it("loses a write made in the same call as setAlarm", async () => {
    const workspace = await create("Probe Write");
    await save(workspace.id, "wrangler.jsonc", wrangler);
    await save(workspace.id, "src/index.ts", app("v1"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    console.log("WRITE call", JSON.stringify(await inPreview(workspace.id, "/write-then-arm")));
    console.log("WRITE after", JSON.stringify(await inPreview(workspace.id, "/rings")));
  });

  it("lets the app host's alarm run the app's scheduled handler, per slot", async () => {
    const workspace = await create("Probe Schedule");
    await save(workspace.id, "wrangler.jsonc", wrangler);
    await save(workspace.id, "src/index.ts", app("v1"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    const { url } = await (await call(`/api/workspaces/${workspace.id}/deployment`, { method: "POST", body: { replaces: null } })).json<Deployment>();
    await save(workspace.id, "src/index.ts", app("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    const label = await env.WORKSPACES.getByName(workspace.id).appLabel();
    const host = env.APP_HOSTS.getByName(label);
    for (const slot of ["preview", "deployment"] as const) {
      await runInDurableObject(host, async (_i, state) => {
        state.storage.kv.put("probe:schedule", { slot, cron: `0 9 * * 1 (${slot})` });
        await state.storage.setAlarm(Date.now() + 100);
      });
      await pause(1000);
      console.log("SCHEDULE ran", slot, JSON.stringify(await runInDurableObject(host, (_i, state) => state.storage.kv.get("probe:ran"))));
    }
    console.log("SCHEDULE preview rings", JSON.stringify(await inPreview(workspace.id, "/rings")));
    console.log("SCHEDULE deployment rings", JSON.stringify(await inDeployment(url, "/rings")));
  });

  it("forwarded: an instance's setAlarm kept by the app host", async () => {
    const workspace = await create("Probe Forwarded");
    await save(workspace.id, "wrangler.jsonc", wrangler);
    await save(workspace.id, "src/index.ts", app("v1"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    const { url } = await (await call(`/api/workspaces/${workspace.id}/deployment`, { method: "POST", body: { replaces: null } })).json<Deployment>();
    console.log("FWD preview armed", JSON.stringify(await inPreview(workspace.id, "/arm?ms=300")));
    console.log("FWD deployment armed", JSON.stringify(await inDeployment(url, "/arm?ms=600")));
    await pause(2000);
    console.log("FWD preview after 2s", JSON.stringify(await inPreview(workspace.id, "/rings")));
    console.log("FWD deployment after 2s", JSON.stringify(await inDeployment(url, "/rings")));
    // Across a new Build that aborts the instance.
    console.log("FWD preview armed again", JSON.stringify(await inPreview(workspace.id, "/arm?ms=1500")));
    await save(workspace.id, "src/index.ts", app("v2"));
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await pause(3000);
    console.log("FWD preview after new Build", JSON.stringify(await inPreview(workspace.id, "/rings")));
    const label = await env.WORKSPACES.getByName(workspace.id).appLabel();
    console.log("FWD host kv", JSON.stringify(await runInDurableObject(env.APP_HOSTS.getByName(label), (_i, state) => [...state.storage.kv.list({ prefix: "probe:" })])));
  });
});
