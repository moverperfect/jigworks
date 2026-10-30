import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BuildReport } from "../src/shared/build-report";
import type { Deployment } from "../src/shared/deployment";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";

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
