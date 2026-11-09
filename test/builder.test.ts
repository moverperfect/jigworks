import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { build, type Snapshot } from "../src/builder";
import { bundledStream, bundlingVersion, filesOf, snapshotFrom } from "../src/builder/bundling";
import { hashOf, tailwindVersion } from "../src/builder/hash";
import { cachingBuilder, isolatedBuilder, tooBigToBuild } from "../src/builder/isolated";
import builderWorker from "../src/generated/builder-worker.txt";
import testBundler from "../src/generated/test-bundler.txt";

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

  it("builds a Package's Workers or browser code, never the Node build it lists first", async () => {
    const files = project('import { where } from "split";\nexport default { fetch: () => new Response(where) };');
    files.set(
      "node_modules/split/package.json",
      JSON.stringify({ name: "split", exports: { ".": { node: { import: "./node.js" }, browser: "./browser.js", default: "./node.js" } } }),
    );
    files.set("node_modules/split/node.js", 'export const where = "node";\n');
    files.set("node_modules/split/browser.js", 'export const where = "browser";\n');
    const result = await build(files);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.modules[result.mainModule]).toContain('"browser"');
    expect(result.modules[result.mainModule]).not.toContain('"node"');
  });

  it("reuses a recent Build of the same inputs, going back and forth", async () => {
    const builder = isolatedBuilder(env.LOADER);
    const first = filesOf(project('export default { fetch: () => new Response("one") };'));
    const second = filesOf(project('export default { fetch: () => new Response("two") };'));
    const built = [await builder.build(first), await builder.build(second), await builder.build(first)];
    expect(built.map(({ cached }) => cached)).toEqual([false, false, true]);
    expect(built[2]!.result.hash).toBe(built[0]!.result.hash);
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

    // Bindings that aren't a list, rather than a list of one.
    const files = project('export default { fetch: () => new Response("hi") };');
    files.set(
      "wrangler.jsonc",
      JSON.stringify({
        name: "app",
        main: "src/index.ts",
        compatibility_date: "2026-10-01",
        durable_objects: { bindings: { name: "COUNTER", class_name: "Counter" } },
      }),
    );
    expect(await build(files)).toMatchObject({ ok: false, errors: [{ file: "wrangler.jsonc", message: expect.stringContaining("durable_objects.bindings") }] });
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

describe("Builds in a Dynamic Worker (#87)", () => {
  // The hash as it was made before #87, from every file at once.
  const hashAtOnce = async (snapshot: Snapshot) => {
    const parts = [`tailwindcss ${tailwindVersion}`, `bundling ${bundlingVersion}`];
    for (const path of [...snapshot.keys()].sort()) parts.push(path, snapshot.get(path)!);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\0")));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  it("hashes the files as before, a part at a time", async () => {
    const files = project('export const café = "naïve ☕";\n');
    // Past the megabyte at which the hash takes in a part, with text either side of it.
    files.set("node_modules/big/index.js", `// ${"é".repeat(700_000)}\n`);
    files.set("node_modules/big/index.d.ts", "export {};\n");
    files.set("src/z.ts", "export const z = 1;\n");
    expect(await hashOf(filesOf(files))).toBe(await hashAtOnce(files));
    expect(await hashOf(filesOf(new Map()))).toBe(await hashAtOnce(new Map()));
  });

  it("sends the files a bundle takes in, and no type declarations, source maps or Markdown", async () => {
    const files = project("export {};\n");
    files.set("src/notes.md", "# Kept\n");
    files.set("node_modules/a/index.js", 'export const a = "line one\\nline two";\n');
    files.set("node_modules/a/index.d.ts", "export declare const a: string;\n");
    files.set("node_modules/a/index.js.map", "{}");
    files.set("node_modules/a/README.md", "# Left behind\n");
    const sent = await snapshotFrom(bundledStream(filesOf(files)));
    expect([...sent.keys()].sort()).toEqual(["node_modules/a/index.js", "package.json", "src/index.ts", "src/notes.md", "wrangler.jsonc"]);
    expect(sent.get("node_modules/a/index.js")).toBe(files.get("node_modules/a/index.js"));
  });

  it("starts esbuild's Go runtime with GOGC=25 in the Builder and the Test bundler, to lower its peak memory", () => {
    for (const packed of [builderWorker, testBundler]) expect(packed.split('this.env={GOGC:"25"}')).toHaveLength(2);
  });

  it("makes the same Build as one made in this isolate", async () => {
    const files = project('import { where } from "split";\nexport default { fetch: () => new Response(where) };');
    files.set("node_modules/split/package.json", JSON.stringify({ name: "split", exports: { ".": "./index.js" } }));
    files.set("node_modules/split/index.js", 'export const where = "here";\n');
    files.set("node_modules/split/index.d.ts", "export declare const where: string;\n");
    const { result, cached, wasmMemoryBytes, receivingMs } = await isolatedBuilder(env.LOADER).build(filesOf(files));
    expect(cached).toBe(false);
    expect(result).toEqual(await build(files));
    expect(result.hash).toBe(await hashAtOnce(files));
    expect(wasmMemoryBytes.esbuild).toBeGreaterThan(0);
    expect(receivingMs).toBeGreaterThanOrEqual(0);
  });

  it("gets more than an RPC call's 32 MiB of files to the Builder", async () => {
    const files = project('export default { fetch: () => new Response("hi") };');
    for (let i = 0; i < 40; i++) files.set(`node_modules/big/part${i}.js`, `export const part = "${String(i % 10).repeat(1_000_000)}";\n`);
    const { result } = await isolatedBuilder(env.LOADER).build(filesOf(files));
    expect(result).toMatchObject({ ok: true });
  });

  it("reports a Builder that fails, or never answers, as a failed Build, and tries again next time", async () => {
    const broken = {
      get: () => {
        throw new Error("Worker exceeded memory limit.");
      },
    } as unknown as WorkerLoader;
    const files = filesOf(project("export {};\n"));
    const builder = isolatedBuilder(broken);
    expect(await builder.build(files)).toMatchObject({
      cached: false,
      result: { ok: false, errors: [{ message: tooBigToBuild, file: null, line: null, column: null }] },
    });
    expect((await builder.build(files)).cached).toBe(false);

    const silent = { get: () => ({ getEntrypoint: () => ({ build: () => new Promise(() => {}) }) }) } as unknown as WorkerLoader;
    // Real timers: this isolate runs the platform's Durable Objects too.
    expect((await isolatedBuilder(silent, 100).build(files)).result).toMatchObject({
      ok: false,
      errors: [{ message: "The Build couldn't run: it took more than 0.1 seconds." }],
    });
  });

  it("tries once more after a Builder goes over its memory limit, which another Workspace's Build can cause, before saying the app is too big", async () => {
    const failures = [new Error("Worker exceeded memory limit.")];
    let made = 0;
    const builder = cachingBuilder(async (_, hash) => {
      made++;
      const failure = failures.shift();
      if (failure) throw failure;
      return { result: { ok: false, hash, errors: [], warnings: [], missingPackages: [] }, wasmMemoryBytes: {}, receivingMs: null };
    });
    expect((await builder.build(filesOf(project("export {};\n")))).result).toMatchObject({ errors: [] });
    expect(made).toBe(2);

    // Only memory: anything else fails at once.
    failures.push(new Error("Network connection lost."));
    expect((await builder.build(filesOf(project("export { a };\n")))).result).toMatchObject({
      errors: [{ message: "The Build couldn't run: Network connection lost.", file: null, line: null, column: null }],
    });
    expect(made).toBe(3);
  });

  it("keeps the Builds it made, and reuses them without esbuild", async () => {
    let made = 0;
    const builder = cachingBuilder(async (_, hash) => {
      made++;
      return { result: { ok: false, hash, errors: [], warnings: [], missingPackages: [] }, wasmMemoryBytes: { esbuild: 1 }, receivingMs: 1 };
    });
    const files = filesOf(project("export {};\n"));
    await builder.build(files);
    expect(await builder.build(files)).toMatchObject({ cached: true, wasmMemoryBytes: {}, receivingMs: null });
    expect(made).toBe(1);
  });
});
