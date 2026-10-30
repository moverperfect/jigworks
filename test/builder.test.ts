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

  it("fails on bindings and triggers the platform doesn't have, saying so", async () => {
    const files = project('export default { fetch: () => new Response("hi") };');
    files.set(
      "wrangler.jsonc",
      JSON.stringify({
        name: "app",
        main: "src/index.ts",
        compatibility_date: "2026-10-01",
        kv_namespaces: [{ binding: "CACHE", id: "x" }],
        d1_databases: [{ binding: "DB", database_id: "x" }],
        r2_buckets: [{ binding: "FILES", bucket_name: "x" }],
        queues: { producers: [{ binding: "JOBS", queue: "x" }] },
        triggers: { crons: ["0 * * * *"] },
      }),
    );
    const result = await build(files);
    expect(result.ok).toBe(false);
    const messages = (result as { errors: { message: string; file: string | null }[] }).errors;
    expect(messages.map(({ message }) => message.split(":")[0])).toEqual([
      "kv_namespaces in wrangler.jsonc",
      "d1_databases in wrangler.jsonc",
      "r2_buckets in wrangler.jsonc",
      "queues in wrangler.jsonc",
      "triggers.crons in wrangler.jsonc",
    ]);
    expect(messages.every(({ message, file }) => message.includes("Durable Objects") && file === "wrangler.jsonc")).toBe(true);
  });

  it("fails on a Durable Object binding whose class the app doesn't export, or that's in another Worker", async () => {
    const files = project('export default { fetch: () => new Response("hi") };');
    files.set(
      "wrangler.jsonc",
      JSON.stringify({
        name: "app",
        main: "src/index.ts",
        compatibility_date: "2026-10-01",
        durable_objects: {
          bindings: [
            { name: "COUNTER", class_name: "Counter" },
            { name: "OTHER", class_name: "Other", script_name: "another-worker" },
          ],
        },
      }),
    );
    const result = await build(files);
    expect(result).toMatchObject({
      ok: false,
      errors: [
        { message: expect.stringContaining('OTHER\'s class is in another Worker ("another-worker")'), file: "wrangler.jsonc" },
        { message: expect.stringContaining('src/index.ts doesn\'t export the class "Counter"'), file: "wrangler.jsonc" },
      ],
    });
  });

  it("reports a malformed Durable Object binding rather than failing to build", async () => {
    for (const binding of [null, "COUNTER", { name: "__proto__", class_name: "Counter" }, { name: "COUNTER", class_name: "default" }]) {
      const files = project('import { DurableObject } from "cloudflare:workers";\nexport class Counter extends DurableObject {}\nexport default { fetch: () => new Response("hi") };');
      files.set(
        "wrangler.jsonc",
        JSON.stringify({ name: "app", main: "src/index.ts", compatibility_date: "2026-10-01", durable_objects: { bindings: [binding] } }),
      );
      expect(await build(files)).toMatchObject({ ok: false, errors: [{ file: "wrangler.jsonc", message: expect.stringContaining("Durable Object binding") }] });
    }
  });

  it("records the Durable Object bindings of a Worker that exports their classes", async () => {
    const files = project('import { DurableObject } from "cloudflare:workers";\nexport class Counter extends DurableObject {}\nexport default { fetch: () => new Response("hi") };');
    files.set(
      "wrangler.jsonc",
      JSON.stringify({ name: "app", main: "src/index.ts", compatibility_date: "2026-10-01", durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] } }),
    );
    expect(await build(files)).toMatchObject({ ok: true, durableObjects: { COUNTER: "Counter" } });
  });

  it("reports a syntax error with its location", async () => {
    const result = await build(project("export default { fetch: () => new Response( };"));
    expect(result).toMatchObject({ ok: false, errors: [{ file: "src/index.ts", line: 1, column: 45 }] });
  });
});
