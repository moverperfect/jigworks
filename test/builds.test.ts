import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BuildReport } from "../src/shared/build-report";
import type { CheckReport } from "../src/workspace";
import { call, create } from "./helpers/api";

// Builds, through the platform's API. The Builder runs in the Workspace's
// Durable Object, with the Packages the fake registry serves.

const build = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/build`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<BuildReport>();
};

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};

const worker = (body: string) => `${body}\nexport default { fetch: () => new Response("hi") };\n`;

describe("Builds", () => {
  it("has no report before the first Build", async () => {
    const workspace = await create("Unbuilt");
    expect(await (await call(`/api/workspaces/${workspace.id}/build`)).json()).toBeNull();
  });

  it("builds a fresh Workspace made from the Worker Template, reuses the Build for the same inputs, and keeps the report", async () => {
    const workspace = await create("Built");
    const first = await build(workspace.id);
    expect(first).toMatchObject({ ok: true, cached: false, errors: [] });
    const second = await build(workspace.id);
    expect(second).toMatchObject({ ok: true, cached: true, hash: first.hash });
    expect(await (await call(`/api/workspaces/${workspace.id}/build`)).json()).toEqual(second);

    await save(workspace.id, "src/notes.ts", "export const notes = 1;\n");
    expect(await build(workspace.id)).toMatchObject({ ok: true, cached: false });
  });

  it("goes ahead when the Check has errors", async () => {
    const workspace = await create("Type error");
    await save(workspace.id, "src/count.ts", 'export const count: number = "many";\n');
    const check = await (await call(`/api/workspaces/${workspace.id}/check`, { method: "POST" })).json<CheckReport>();
    expect(check.counts.error).toBe(1);
    expect(await build(workspace.id)).toMatchObject({ ok: true });
  });

  it("fails with esbuild's errors, with their locations", async () => {
    const workspace = await create("Syntax error");
    await save(workspace.id, "src/index.ts", "export default { fetch: () => new Response( };\n");
    expect(await build(workspace.id)).toMatchObject({ ok: false, errors: [{ file: "src/index.ts", line: 1, column: 45 }] });
  });

  it("fails when the output still imports a package that isn't installed, naming it", async () => {
    const workspace = await create("Missing package");
    await save(workspace.id, "src/index.ts", worker('import leftPad from "left-pad";\nconsole.log(leftPad);'));
    expect(await build(workspace.id)).toMatchObject({
      ok: false,
      errors: [{ message: 'bundle.js imports "left-pad", which isn\'t in the Workspace\'s Packages' }],
    });
  });

  it("installs Packages first when package.json changed without a save, as Think's tools change it", async () => {
    const workspace = await create("Tools");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance) => {
      const manifest = { name: "app", private: true, type: "module", dependencies: { "@fake/a": "1.0.0", hono: "4.13.13" } };
      await instance.workspace.writeFile("/package.json", JSON.stringify(manifest));
      await instance.workspace.writeFile("/src/index.ts", worker('import { name } from "@fake/a";\nconsole.log(name);'));
    });
    expect(await build(workspace.id)).toMatchObject({ ok: true, errors: [] });
  });
});
