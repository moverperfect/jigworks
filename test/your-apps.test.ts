import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Developer, WorkspaceRecord } from "../src/developer";
import type { Deployment } from "../src/shared/deployment";
import type { Workspace } from "../src/workspace";
import { testAccess } from "./helpers/access";
import { call, create, createFromMessage } from "./helpers/api";
import { connect, runTurn } from "./helpers/conversation";

// The start page's list of apps: whether each is live and when it last
// changed, and renaming an app from its page (#62).

const list = async () => (await (await call("/api/workspaces")).json<{ workspaces: WorkspaceRecord[] }>()).workspaces;
const listed = async (id: string) => (await list()).find((workspace) => workspace.id === id)!;
const time = (iso: string | null) => Date.parse(iso ?? "");

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};
const build = async (id: string) => expect((await call(`/api/workspaces/${id}/build`, { method: "POST" })).status).toBe(200);
const deployment = async (id: string) => (await call(`/api/workspaces/${id}/deployment`)).json<Deployment>();
const rename = (id: string, name: unknown, email?: string) => call(`/api/workspaces/${id}`, { method: "PATCH", body: { name }, email });

describe("the Developer's list", () => {
  it("starts a new app as changed when it was made, and not published", async () => {
    const workspace = await create("Fresh");
    expect(workspace).toMatchObject({ changedAt: workspace.createdAt, publishedAt: null });
    expect(await listed(workspace.id)).toEqual(workspace);
  });

  it("records a change at the end of each Turn", async () => {
    const workspace = await create("Turned");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    conversation.close();
    const after = await listed(workspace.id);
    expect(time(after.changedAt)).toBeGreaterThan(time(workspace.changedAt));
  });

  it("records a change after each of the Developer's own saves, and lists the most recently changed first", async () => {
    const older = await create("Saved");
    const newer = await create("Untouched");
    expect((await list()).map(({ id }) => id).slice(0, 2)).toEqual([newer.id, older.id]);

    await save(older.id, "src/index.ts", "export default {};\n");
    const after = await listed(older.id);
    expect(time(after.changedAt)).toBeGreaterThan(time(older.changedAt));
    expect((await list()).map(({ id }) => id).slice(0, 2)).toEqual([older.id, newer.id]);
  });

  it("records a change after the Developer adds a Package", async () => {
    const workspace = await create("Packaged");
    const response = await call(`/api/workspaces/${workspace.id}/packages`, { method: "POST", body: { name: "@fake/a" } });
    expect(response.status).toBe(200);
    await response.text();
    expect(time((await listed(workspace.id)).changedAt)).toBeGreaterThan(time(workspace.changedAt));
  });

  it("records each publish, without counting it as a change", async () => {
    const workspace = await create("Published");
    await build(workspace.id);
    const before = await listed(workspace.id);
    const response = await call(`/api/workspaces/${workspace.id}/deployment`, { method: "POST", body: { replaces: null } });
    expect(response.status).toBe(200);
    const { publishedAt } = await response.json<Deployment>();
    expect(await listed(workspace.id)).toEqual({ ...before, publishedAt });
  });

  it("records a change when a restart ends a Turn", async () => {
    const workspace = await create("Restarted");
    // A Turn the isolate that stopped was running, as a new isolate finds it.
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance: Workspace) => {
      instance.setState({ ...instance.state, turn: { startedAt: new Date().toISOString(), stage: "working" } });
      await instance.onStart();
    });
    expect(time((await listed(workspace.id)).changedAt)).toBeGreaterThan(time(workspace.changedAt));
  });

  it("fills in the times of the apps listed before it kept them, asking again until every Workspace answers", async () => {
    // An app published before the list recorded publishing, and a Workspace
    // made before it recorded its Developer.
    const workspace = await create("Listed before");
    await build(workspace.id);
    const published = await call(`/api/workspaces/${workspace.id}/deployment`, { method: "POST", body: { replaces: null } });
    const { publishedAt } = await published.json<Deployment>();
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (_: Workspace, state) => state.storage.kv.delete("developer"));

    const email = "earlier@example.com";
    const createdAt = "2026-01-02T03:04:05.000Z";
    const before = { id: workspace.id, name: "Listed before", template: "worker", createdAt, changedAt: createdAt };
    await runInDurableObject(env.DEVELOPERS.getByName(email), async (instance: Developer, state) => {
      state.storage.sql.exec("DROP TABLE workspaces");
      state.storage.sql.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL, created_at TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO workspaces VALUES (?, ?, ?, ?)", workspace.id, "Listed before", "worker", createdAt);
      state.storage.kv.delete("schema");
      instance.migrate();

      // A Workspace that can't answer keeps the times it was made with, for now.
      const own = instance as unknown as { env: Env };
      const real = own.env;
      own.env = { ...real, WORKSPACES: { getByName: () => ({ joinList: () => Promise.reject(new Error("unreachable")) }) } as never };
      expect(await instance.list()).toEqual([{ ...before, publishedAt: null }]);
      own.env = real;
      expect(await instance.list()).toEqual([{ ...before, publishedAt }]);
    });
    // The Workspace now knows whose list it's on, so it keeps it up to date.
    const owner = await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (_: Workspace, state) => state.storage.kv.get("developer"));
    expect(owner).toBe(email);
  });
});

describe("renaming an app", () => {
  it("changes the name in the list, and keeps the label and so the address", async () => {
    const workspace = await create("Bake sale");
    const { url } = await deployment(workspace.id);
    const response = await rename(workspace.id, "  Bake sale orders  ");
    expect(response.status).toBe(200);
    const { workspace: renamed } = await response.json<{ workspace: WorkspaceRecord }>();
    expect(renamed).toEqual({ ...workspace, name: "Bake sale orders" });
    expect(await listed(workspace.id)).toEqual(renamed);
    expect((await deployment(workspace.id)).url).toBe(url);
  });

  it.each([
    ["   ", "Enter a name for your app."],
    ["x".repeat(61), "Use 60 characters or fewer. This name has 61."],
    [42, "Enter a name for your app."],
  ])("refuses %j", async (name, error) => {
    const workspace = await create("Keep this name");
    const response = await rename(workspace.id, name);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect((await listed(workspace.id)).name).toBe("Keep this name");
  });

  it("is refused until the Agent has started the app and named it", async () => {
    const workspace = await createFromMessage("[script:say-hello] Hi");
    const response = await rename(workspace.id, "Mine");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Your app hasn't started yet. Wait for the Agent to start it." });
  });

  it("answers 404 for another Developer's app", async () => {
    const workspace = await create("Not theirs");
    const response = await rename(workspace.id, "Theirs now", testAccess.secondDeveloper);
    expect(response.status).toBe(404);
    await response.text();
  });

  it("makes Delete ask for the new name", async () => {
    const workspace = await create("Old name");
    expect((await rename(workspace.id, "New name")).status).toBe(200);
    const refused = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: "Old name" } });
    expect(refused.status).toBe(400);
    await refused.text();
    const deleted = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: "New name" } });
    expect(deleted.status).toBe(204);
  });
});
