import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { PackageStatus } from "../src/packages";
import { call, create } from "./helpers/api";

// Installing Packages, through the platform's API. The npm registry is the
// fake one in test/fixtures/registry-data.ts.

type Added = PackageStatus & { package: { name: string; version: string } };

const status = async (id: string) => (await call(`/api/workspaces/${id}/packages`)).json<PackageStatus>();

async function add(id: string, body: { name: string; range?: string; dev?: boolean }): Promise<Added> {
  const response = await call(`/api/workspaces/${id}/packages`, { method: "POST", body });
  expect(response.status).toBe(200);
  return response.json<Added>();
}

async function packageJson(id: string): Promise<Record<string, Record<string, string>>> {
  const zip = unzipSync(new Uint8Array(await (await call(`/api/workspaces/${id}/export`)).arrayBuffer()));
  return JSON.parse(strFromU8(zip["package.json"]!));
}

const installed = (result: PackageStatus) => Object.fromEntries(result.packages.map((p) => [p.name, p.version]));

describe("installing a new Workspace's Packages", () => {
  it("installs the Template's Packages when the Workspace is created", async () => {
    const workspace = await create("Fresh");
    expect(await status(workspace.id)).toEqual({
      state: "installed",
      packages: [{ name: "hono", version: "4.13.13" }],
      warnings: [],
      error: null,
    });
  });

  it("keeps only the file types a Check or a Build reads", async () => {
    const workspace = await create("Filtered");
    const files = await env.WORKSPACES.getByName(workspace.id).packageFiles();
    expect(Object.keys(files).sort()).toEqual([
      "node_modules/hono/dist/index.d.ts",
      "node_modules/hono/dist/index.js",
      "node_modules/hono/package.json",
    ]);
  });

  it("never puts Packages in the Workspace's files", async () => {
    const workspace = await create("No node_modules");
    const zip = unzipSync(new Uint8Array(await (await call(`/api/workspaces/${workspace.id}/export`)).arrayBuffer()));
    expect(Object.keys(zip).filter((path) => path.startsWith("node_modules"))).toEqual([]);
  });
});

describe("adding a Package", () => {
  it("picks the newest version that's at least a day old, and writes it exactly", async () => {
    const workspace = await create("Add");
    const result = await add(workspace.id, { name: "@fake/a" });
    expect(result.package).toEqual({ name: "@fake/a", version: "1.0.0" });
    // @fake/shared 1.3.0 is too new as well, even though only @fake/a asked for it.
    expect(installed(result)).toEqual({ "@fake/a": "1.0.0", "@fake/shared": "1.2.0", hono: "4.13.13" });
    expect((await packageJson(workspace.id)).dependencies).toEqual({ "@fake/a": "1.0.0", hono: "4.13.13" });
  });

  it("treats a version without a publish time as too new", async () => {
    const workspace = await create("Untimed");
    const result = await add(workspace.id, { name: "@fake/untimed" });
    expect(result.package.version).toBe("1.0.0");
  });

  it("honours a version range", async () => {
    const workspace = await create("Range");
    const result = await add(workspace.id, { name: "@fake/shared", range: "~1.0.0" });
    expect(result.package.version).toBe("1.0.0");
  });

  it("puts type Packages in devDependencies", async () => {
    const workspace = await create("Types");
    await add(workspace.id, { name: "@types/fake" });
    expect((await packageJson(workspace.id)).devDependencies).toEqual({ "@types/fake": "1.0.0" });
  });

  it.each([
    [{ name: "@fake/too-new" }, "No version of @fake/too-new is at least a day old."],
    [{ name: "@fake/missing" }, "@fake/missing isn't in the npm registry."],
    [{ name: "Not A Name" }, "Not A Name isn't a valid Package name."],
    [{ name: "@fake/a", range: "^9.0.0" }, "No version of @fake/a matches ^9.0.0."],
  ])("refuses %j", async (body, error) => {
    const workspace = await create("Refused");
    const response = await call(`/api/workspaces/${workspace.id}/packages`, { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });
});

describe("one version of each Package", () => {
  it("warns when two Packages need different versions of a third", async () => {
    const workspace = await create("Conflict");
    await add(workspace.id, { name: "@fake/a" });
    const result = await add(workspace.id, { name: "@fake/b" });
    expect(installed(result)["@fake/shared"]).toBe("1.2.0");
    expect(result.warnings).toEqual(["@fake/shared@1.2.0 is installed, but @fake/b@2.0.0 wants ^2.0.0."]);
  });

  it("lets a version listed in package.json win", async () => {
    const workspace = await create("Direct wins");
    await add(workspace.id, { name: "@fake/a" });
    const result = await add(workspace.id, { name: "@fake/shared", range: "2.0.0" });
    expect(installed(result)["@fake/shared"]).toBe("2.0.0");
    expect(result.warnings).toEqual(["@fake/shared@2.0.0 is installed, but @fake/a@1.0.0 wants ^1.0.0."]);
  });

  it("counts a requirement for a tag such as latest when it warns", async () => {
    const workspace = await create("Tag");
    await add(workspace.id, { name: "@fake/shared", range: "1.0.0" });
    const result = await add(workspace.id, { name: "@fake/tag-user" });
    expect(result.warnings).toEqual(["@fake/shared@1.0.0 is installed, but @fake/tag-user@1.0.0 wants latest."]);
  });

  it("still installs a Package for the others when one asks for it in a way the platform can't read", async () => {
    const workspace = await create("Alias");
    await add(workspace.id, { name: "@fake/a" });
    const result = await add(workspace.id, { name: "@fake/aliased" });
    expect(installed(result)["@fake/shared"]).toBe("1.2.0");
    expect(result.warnings).toEqual([
      "@fake/aliased@1.0.0 asks for @fake/shared@npm:@fake/host@2.0.0, a kind of version the platform can't install.",
    ]);
  });

  it("warns about a peer requirement no version can meet", async () => {
    const workspace = await create("Peer");
    const result = await add(workspace.id, { name: "@fake/plugin" });
    expect(result.warnings).toEqual(["No version of @fake/host matches ^3.0.0."]);
  });

  it("skips Packages built for one operating system or CPU", async () => {
    const workspace = await create("Native");
    const result = await add(workspace.id, { name: "@fake/with-native" });
    expect(installed(result)).toEqual({ "@fake/with-native": "1.0.0", hono: "4.13.13" });
    expect(result.warnings).toEqual([]);
  });
});

describe("changing package.json by hand", () => {
  it("removes Packages it no longer lists", async () => {
    const workspace = await create("Remove");
    await add(workspace.id, { name: "@fake/a" });
    const saved = await call(`/api/workspaces/${workspace.id}/files/package.json`, {
      method: "PUT",
      text: JSON.stringify({ name: "app", dependencies: { hono: "4.13.13" } }),
    });
    expect(saved.status).toBe(204);
    expect(installed(await status(workspace.id))).toEqual({ hono: "4.13.13" });
    const files = await env.WORKSPACES.getByName(workspace.id).packageFiles();
    expect(Object.keys(files).some((path) => path.startsWith("node_modules/@fake/"))).toBe(false);
  });

  it("records a package.json that isn't valid JSON as a failed install", async () => {
    const workspace = await create("Broken");
    await call(`/api/workspaces/${workspace.id}/files/package.json`, { method: "PUT", text: "{ not json" });
    expect(await status(workspace.id)).toMatchObject({ state: "failed", error: "package.json isn't valid JSON." });
  });

  it("records dependency fields that aren't maps of versions as a failed install", async () => {
    const workspace = await create("Null");
    const saved = await call(`/api/workspaces/${workspace.id}/files/package.json`, {
      method: "PUT",
      text: JSON.stringify({ name: "app", dependencies: null }),
    });
    expect(saved.status).toBe(204);
    expect(await status(workspace.id)).toMatchObject({
      state: "failed",
      error: "package.json's dependencies must map Package names to versions.",
    });
  });

  it("refuses a path outside the Workspace or kept for the Conversation", async () => {
    const workspace = await create("Paths");
    for (const path of ["..%2Fescape.ts", "attachments/photo.txt"]) {
      const response = await call(`/api/workspaces/${workspace.id}/files/${path}`, { method: "PUT", text: "x" });
      expect(response.status).toBe(400);
      await response.text();
    }
  });
});
