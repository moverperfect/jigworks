import { env, exports } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "../src/developer";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";

describe("signing in", () => {
  it("refuses a request without an Access token", async () => {
    const response = await call("/api/me", { token: null });
    expect(response.status).toBe(401);
    await response.text();
  });

  it("refuses a token from another Access application", async () => {
    const token = await accessToken({ email: testAccess.developer }, { audience: "someone-elses-app" });
    const response = await call("/api/me", { token });
    expect(response.status).toBe(401);
    await response.text();
  });

  it("refuses someone who isn't a Developer", async () => {
    const response = await call("/api/me", { email: "visitor@example.com" });
    expect(response.status).toBe(403);
    expect(await response.json<{ error: string }>()).toEqual({
      error: "visitor@example.com isn't a Developer on this platform.",
    });
  });

  it.each(["someone@team.example", "Someone@TEAM.example"])(
    "lets in %s, at a domain on the Developer list",
    async (email) => {
      const response = await call("/api/me", { email });
      expect(await response.json()).toEqual({ email: "someone@team.example" });
    },
  );

  it.each(["someone@sub.team.example", "someone@team.example.evil", "someone@evilteam.example"])(
    "refuses %s, which only looks like a domain on the Developer list",
    async (email) => {
      const response = await call("/api/me", { email });
      expect(response.status).toBe(403);
      await response.text();
    },
  );

  it("refuses a service token", async () => {
    const token = await accessToken({ common_name: "abc.access" });
    const response = await call("/api/me", { token });
    expect(response.status).toBe(403);
    await response.text();
  });

  it("tells the pages who is signed in", async () => {
    const response = await call("/api/me");
    expect(await response.json()).toEqual({ email: testAccess.developer });
  });
});

describe("Requests from elsewhere", () => {
  it("refuses a change without an Origin", async () => {
    const response = await call("/api/workspaces", { method: "POST", body: { name: "x", template: "worker" }, origin: null });
    expect(response.status).toBe(403);
    await response.text();
  });

  it("refuses a request from an app's hostname", async () => {
    const response = await call("/api/workspaces", { origin: testAccess.appOrigin });
    expect(response.status).toBe(403);
    await response.text();
  });

  it.each([null, testAccess.appOrigin])("refuses a WebSocket upgrade with Origin %s", async (origin) => {
    const headers = new Headers({ Upgrade: "websocket", "Cf-Access-Jwt-Assertion": await accessToken() });
    if (origin) headers.set("Origin", origin);
    const response = await exports.default.fetch(new Request(`${testAccess.origin}/api/workspaces`, { headers }));
    expect(response.status).toBe(403);
    await response.text();
  });

  it("refuses a read an app's page sends from the same site", async () => {
    const response = await call("/api/workspaces", { origin: null, site: "same-site" });
    expect(response.status).toBe(403);
    await response.text();
  });

  it("allows the Developer opening an API URL themselves", async () => {
    const response = await call("/api/me", { origin: null, site: "none" });
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe("Templates", () => {
  it("lists the Worker Template, then the Worker + React Template", async () => {
    const { templates } = await (await call("/api/templates")).json<{ templates: { id: string }[] }>();
    expect(templates).toEqual([
      expect.objectContaining({ id: "worker", name: "Worker" }),
      expect.objectContaining({ id: "worker-react", name: "Worker + React" }),
    ]);
  });
});

describe("Workspaces", () => {
  it("starts with none", async () => {
    expect(await (await call("/api/workspaces")).json()).toEqual({ workspaces: [] });
  });

  it("creates a Workspace from a Template and lists the newest first", async () => {
    const first = await create("First");
    const second = await create("  Second  ");
    expect(second.name).toBe("Second");
    const { workspaces } = await (await call("/api/workspaces")).json<{ workspaces: WorkspaceRecord[] }>();
    expect(workspaces.map((workspace) => workspace.id)).toEqual([second.id, first.id]);
  });

  it.each([
    [{ name: "   ", template: "worker" }, "Enter a name for the Workspace."],
    [{ name: "x".repeat(61), template: "worker" }, "Use 60 characters or fewer. This name has 61."],
    [{ name: "Fine", template: "no-such-template" }, "There's no Template with that name."],
  ])("refuses %j", async (body, error) => {
    const response = await call("/api/workspaces", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it("gets one Workspace", async () => {
    const workspace = await create("One");
    expect(await (await call(`/api/workspaces/${workspace.id}`)).json()).toEqual({ workspace });
    const missing = await call("/api/workspaces/nope");
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it("keeps each Developer's Workspaces to themselves", async () => {
    const mine = await create("Mine");
    const theirs = await call("/api/workspaces", { email: testAccess.secondDeveloper });
    expect(await theirs.json()).toEqual({ workspaces: [] });
    const response = await call(`/api/workspaces/${mine.id}/export`, { email: testAccess.secondDeveloper });
    expect(response.status).toBe(404);
    await response.text();
  });
});

describe("Exporting a Workspace", () => {
  it("zips the Workspace's files, which start as the Template's", async () => {
    const workspace = await create("Café app");
    const response = await call(`/api/workspaces/${workspace.id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="Caf- app.zip"; filename*=UTF-8''Caf%C3%A9%20app.zip`,
    );
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(
      ["AGENTS.md", "package.json", "src/index.test.ts", "src/index.ts", "tsconfig.json", "worker-configuration.d.ts", "wrangler.jsonc"].sort(),
    );
    expect(JSON.parse(strFromU8(files["package.json"]!))).toMatchObject({ dependencies: { hono: "4.13.13" } });
  });

});

describe("Deleting a Workspace", () => {
  it("needs the Workspace's name typed exactly", async () => {
    const workspace = await create("Keep me");
    const response = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: "keep me" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Type the Workspace's name exactly to delete it." });
  });

  it("removes it from the list and deletes its files", async () => {
    const workspace = await create("Delete me");
    const response = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: "Delete me" } });
    expect(response.status).toBe(204);
    const { workspaces } = await (await call("/api/workspaces")).json<{ workspaces: WorkspaceRecord[] }>();
    expect(workspaces.map((record) => record.id)).not.toContain(workspace.id);
    expect(await env.WORKSPACES.getByName(workspace.id).exportFiles()).toEqual({});
  });

  it("answers 404 for a Workspace that doesn't exist", async () => {
    const response = await call("/api/workspaces/nope", { method: "DELETE", body: { confirmName: "x" } });
    expect(response.status).toBe(404);
    await response.text();
  });
});
