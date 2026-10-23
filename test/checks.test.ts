import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Packages } from "../src/packages";
import type { Registry } from "../src/packages/registry";
import type { CheckReport } from "../src/workspace";
import { call, create } from "./helpers/api";

// The Workspace page's files and Checks, through the platform's API. Checks
// run ts-rust in a Dynamic Worker, as they do deployed.

const check = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/check`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<CheckReport>();
};

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};

describe("a Workspace's files", () => {
  it("lists their paths, without Packages or Conversation attachments", async () => {
    const workspace = await create("Files");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance) => {
      await instance.workspace.writeFile("/attachments/photo.txt", "a Conversation attachment");
    });
    const { files } = await (await call(`/api/workspaces/${workspace.id}/files`)).json<{ files: string[] }>();
    expect(files).toEqual([
      "AGENTS.md",
      "package.json",
      "src/index.ts",
      "tsconfig.json",
      "worker-configuration.d.ts",
      "wrangler.jsonc",
    ]);
  });

  it("reads one file as text", async () => {
    const workspace = await create("Read");
    await save(workspace.id, "src/notes/café.md", "# Notes\n");
    const response = await call(`/api/workspaces/${workspace.id}/files/src/notes/${encodeURIComponent("café.md")}`);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("# Notes\n");
  });

  it("answers 415 for a file that isn't text", async () => {
    const workspace = await create("Binary");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance) => {
      await instance.workspace.writeFileBytes("/public/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    });
    const response = await call(`/api/workspaces/${workspace.id}/files/public/logo.png`);
    expect(response.status).toBe(415);
    await response.text();
  });

  it.each(["src/missing.ts", "attachments/photo.txt", "..%2Fescape.ts"])("answers 404 for %s", async (path) => {
    const workspace = await create("Missing");
    const response = await call(`/api/workspaces/${workspace.id}/files/${path}`);
    expect(response.status).toBe(404);
    await response.text();
  });
});

describe("Checks", () => {
  it("has no report before the first Check", async () => {
    const workspace = await create("Unchecked");
    expect(await (await call(`/api/workspaces/${workspace.id}/check`)).json()).toBeNull();
  });

  it("finds no problems in a fresh Workspace made from the Worker Template, and keeps the report", async () => {
    const workspace = await create("Clean");
    const report = await check(workspace.id);
    expect(report).toMatchObject({
      projects: ["tsconfig.json"],
      problems: [],
      counts: { error: 0, warning: 0, suggestion: 0, message: 0 },
      packages: { state: "installed", packages: [{ name: "hono", version: "4.13.13" }] },
    });
    expect(await (await call(`/api/workspaces/${workspace.id}/check`)).json()).toEqual(report);
  });

  it("reports a type error in a saved file", async () => {
    const workspace = await create("Broken");
    await save(workspace.id, "src/broken.ts", "export const count: number = 'many';\n");
    const report = await check(workspace.id);
    expect(report.problems).toEqual([
      expect.objectContaining({ file: "src/broken.ts", line: 1, column: 14, code: 2322, severity: "error" }),
    ]);
    expect(report.counts.error).toBe(1);
  });

  it("installs Packages first when package.json changed without a save, as Think's tools change it", async () => {
    const workspace = await create("Tools");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance) => {
      const manifest = { name: "app", private: true, type: "module", dependencies: { "@fake/a": "1.0.0", hono: "4.13.13" } };
      await instance.workspace.writeFile("/package.json", JSON.stringify(manifest));
    });
    const report = await check(workspace.id);
    expect(report.packages.packages.map((p) => p.name)).toEqual(["@fake/a", "@fake/shared", "hono"]);
  });

  it("runs after a failed install without trying that install again", async () => {
    const workspace = await create("Failed");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance, state) => {
      const manifest = JSON.stringify({ name: "app", private: true, dependencies: { "@fake/a": "1.0.0" } });
      await instance.workspace.writeFile("/package.json", manifest);
      const down: Registry = {
        document: () => Promise.reject(new Error("npm is down")),
        publishTimes: () => Promise.reject(new Error("npm is down")),
      };
      expect(await new Packages(state.storage).install(manifest, { registry: down })).toMatchObject({ state: "failed" });
    });
    // The fake registry is up, so a retry would install @fake/a.
    const report = await check(workspace.id);
    expect(report.packages).toMatchObject({ state: "failed", error: "npm is down" });
    expect(report.projects).toEqual(["tsconfig.json"]);
  });
});
