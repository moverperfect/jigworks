import { describe, expect, it } from "vitest";
import { build, inProcessBuilder } from "../src/builder";

const project = (source: string) =>
  new Map([
    ["package.json", JSON.stringify({ name: "app", private: true, type: "module" })],
    ["wrangler.jsonc", '{ "name": "app", "main": "src/index.ts", "compatibility_date": "2026-10-01" }'],
    ["src/index.ts", source],
  ]);

describe("build", () => {
  it("builds a Worker with no Packages", async () => {
    const result = await build(project('export default { fetch: () => new Response("hi") };'));
    expect(result).toMatchObject({ ok: true, mainModule: "bundle.js", compatibilityDate: "2026-10-01" });
  });

  it("takes the compatibility settings and plain-text vars from wrangler.jsonc", async () => {
    const files = project('export default { fetch: () => new Response("hi") };');
    files.set(
      "wrangler.jsonc",
      `{
        // Comments are allowed.
        "name": "app",
        "main": "src/index.ts",
        "compatibility_date": "2026-09-01",
        "compatibility_flags": ["nodejs_compat"],
        "vars": { "GREETING": "Hello", "LIMITS": { "max": 3 } },
      }`,
    );
    expect(await build(files)).toMatchObject({
      ok: true,
      compatibilityDate: "2026-09-01",
      compatibilityFlags: ["nodejs_compat"],
      vars: { GREETING: "Hello" },
    });
  });

  it("fails when the output still imports a Package that isn't in the Workspace", async () => {
    const result = await build(
      project('import leftPad from "left-pad";\nexport default { fetch: () => new Response(leftPad("x", 3)) };'),
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [{ message: 'bundle.js imports "left-pad", which isn\'t in the Workspace\'s Packages', file: null }],
      missingPackages: ["left-pad"],
    });
  });

  it("never installs a Package itself, even one package.json lists", async () => {
    // The fake registry has @fake/a, so the bundler's own installer would find it.
    const files = project('import { name } from "@fake/a";\nexport default { fetch: () => new Response(name) };');
    files.set("package.json", JSON.stringify({ name: "app", private: true, type: "module", dependencies: { "@fake/a": "1.0.0" } }));
    expect(await build(files)).toMatchObject({ ok: false, missingPackages: ["@fake/a"] });
  });

  it("reuses a recent Build of the same inputs, going back and forth", async () => {
    const builder = inProcessBuilder();
    const first = project('export default { fetch: () => new Response("one") };');
    const second = project('export default { fetch: () => new Response("two") };');
    const built = [await builder.build(first), await builder.build(second), await builder.build(first)];
    expect(built.map((result) => result.cached)).toEqual([false, false, true]);
    expect(built[2]!.hash).toBe(built[0]!.hash);
  });

  it("allows the runtime's own modules", async () => {
    const result = await build(
      project(
        'import { DurableObject } from "cloudflare:workers";\nimport { Buffer } from "node:buffer";\nexport class A extends DurableObject {}\nexport default { fetch: () => new Response(Buffer.from("hi")) };',
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("reports a syntax error with its location", async () => {
    const result = await build(project("export default { fetch: () => new Response( };"));
    expect(result).toMatchObject({ ok: false, errors: [{ file: "src/index.ts", line: 1, column: 45 }] });
  });
});
