import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { build, type Build, type BuildFailure } from "../src/builder";
import type { BuildReport } from "../src/shared/build-report";
import type { TestReport } from "../src/shared/test-report";
import type { CheckReport } from "../src/workspace";
import { registryPackages } from "./fixtures/registry-data";
import { call, create } from "./helpers/api";

// Builds with a front end: index.html names the scripts and stylesheets the
// Build bundles, and a stylesheet that imports tailwindcss goes through the
// platform's Tailwind step (ADR 0007).

// The fake registry's React, laid out as the Workspace's Packages are.
const react = Object.fromEntries(
  Object.entries(registryPackages.find((fake) => fake.name === "react")!.versions["19.3.1"]!.files).map(([path, text]) => [
    `node_modules/react/${path}`,
    text,
  ]),
);

const page = `<!doctype html>
<html>
  <head>
    <link rel="icon" href="/favicon.svg" />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
`;

const app = (files: Record<string, string>) =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
      "wrangler.jsonc": '{ "name": "app", "main": "src/server/index.ts", "compatibility_date": "2026-10-01" }',
      "src/server/index.ts": 'export default { fetch: () => new Response("api") };\n',
      "index.html": page,
      "public/favicon.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      "src/client/main.tsx": 'export const App = () => <main className="flex p-4 md:grid">Hi</main>;\n',
      "src/styles.css": '@import "tailwindcss";\n',
      ...react,
      ...files,
    }),
  );

const built = async (files: Record<string, string>) => {
  const result = await build(app(files));
  if (!result.ok) throw new Error(`The Build failed: ${JSON.stringify(result.errors)}`);
  return result;
};

const failed = async (files: Record<string, string>) => {
  const result = await build(app(files));
  expect(result.ok).toBe(false);
  return result as BuildFailure;
};

const css = (result: Build) => result.assets["/styles.css"]!;

describe("a Build with a front end", () => {
  it("bundles the scripts and stylesheets index.html links, and points index.html at them", async () => {
    const result = await built({});
    const html = result.assets["/index.html"]!;
    expect(html).toContain('<script type="module" src="/client/main.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" />');
    expect(result.assets["/client/main.js"]).toContain("Hi");
    expect(result.assets["/favicon.svg"]).toContain("<svg");
    expect(result.assetManifest["/styles.css"]).toMatchObject({ contentType: expect.stringContaining("text/css") });
  });

  it("compiles Tailwind from the class names in the Workspace's files, and only those", async () => {
    const result = await built({
      "src/client/main.tsx": [
        'const active = "bg-sky-500";',
        "export const App = () => (",
        '  <main className={`flex hover:underline ${active}`}>',
        '    <p className="p-[13px] md:grid text-sm/6">Hi</p>',
        `    <div className="bg-[url('/hero.svg')] before:content-[''] font-['Inter']" />`,
        "  </main>",
        ");",
        "",
      ].join("\n"),
    });
    for (const rule of [
      ".flex",
      ".hover\\:underline",
      ".bg-sky-500",
      ".p-\\[13px\\]",
      ".md\\:grid",
      ".text-sm\\/6",
      "url('/hero.svg')",
      ".before\\:content-\\[\\'\\'\\]",
      "font-family: 'Inter'",
    ]) {
      expect(css(result)).toContain(rule);
    }
    expect(css(result)).not.toContain(".bg-red-500");
    // Tailwind's own reset comes with it.
    expect(css(result)).toContain("box-sizing: border-box");
  });

  it("finds class names in unquoted HTML attributes, and keeps arbitrary variants whole", async () => {
    const result = await built({
      "index.html": page.replace('<div id="root"></div>', '<main class=flex-col>Hi</main><p class="[&>*]:p-4 data-[state=open]:block">Hi</p>'),
    });
    for (const rule of [".flex-col", ".\\[\\&\\>\\*\\]\\:p-4", ".data-\\[state\\=open\\]\\:block"]) {
      expect(css(result)).toContain(rule);
    }
  });

  it("finds Tailwind through a stylesheet it imports, however the import names it", async () => {
    for (const id of ["/src/base.css", "./base.css", "base.css"]) {
      const result = await built({
        "src/styles.css": `@import "${id}";\n`,
        "src/base.css": '@import "tailwindcss";\n',
        "src/client/main.tsx": 'export const App = () => <p className="underline">Hi</p>;\n',
      });
      expect(css(result)).toContain(".underline");
    }
  });

  it("includes the Workspace's own stylesheets that a Tailwind stylesheet imports", async () => {
    const result = await built({
      "src/styles.css": '@import "tailwindcss";\n@import "./theme.css";\n',
      "src/theme.css": "@theme {\n  --color-brand: #0b5fff;\n}\n.card {\n  @apply rounded p-2;\n}\n",
      "src/client/main.tsx": 'export const App = () => <p className="text-brand card">Hi</p>;\n',
    });
    expect(css(result)).toContain("--color-brand: #0b5fff");
    expect(css(result)).toContain(".text-brand");
    expect(css(result)).toMatch(/\.card\s*\{[^}]*border-radius/);
  });

  it("fails on @plugin or @config, at the line that has it, rather than ignoring it", async () => {
    const plugin = await failed({ "src/styles.css": '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n' });
    expect(plugin.errors).toEqual([
      expect.objectContaining({ file: "src/styles.css", line: 2, message: expect.stringContaining("@plugin") }),
    ]);
    // A gap in the platform's Tailwind, counted apart from mistakes in the CSS.
    expect(plugin.tailwindFailure).toBe("unsupported");

    const config = await failed({
      "src/styles.css": '@import "tailwindcss";\n@import "./more.css";\n',
      "src/more.css": '/* @plugin in a comment is fine */\n@config "../tailwind.config.js";\n',
    });
    expect(config.errors).toEqual([
      expect.objectContaining({ file: "src/more.css", line: 2, message: expect.stringContaining("@config") }),
    ]);
  });

  it("takes @plugin in a string or a comment for what it is", async () => {
    const result = await built({
      "src/styles.css": '@import "tailwindcss";\n/* @plugin */\n.quote::before { content: "@plugin @config"; }\n',
    });
    expect(css(result)).toContain('"@plugin @config"');
  });

  it("reports Tailwind's own errors as Build errors", async () => {
    const result = await failed({ "src/styles.css": '@import "tailwindcss";\n.card { @apply not-a-utility; }\n' });
    expect(result.errors).toEqual([
      expect.objectContaining({ file: "src/styles.css", message: expect.stringContaining("not-a-utility") }),
    ]);
    expect(result.tailwindFailure).toBe("error");
  });

  it("bundles a plain stylesheet with its @imports, without Tailwind", async () => {
    const result = await built({
      "src/styles.css": '@import "./base.css";\nmain { color: rebeccapurple; }\n',
      "src/base.css": "body { margin: 0; }\n",
    });
    expect(css(result)).toMatch(/body\s*\{\s*margin:\s*0;?\s*\}/);
    // Minified, as the bundler minifies the front end.
    expect(css(result)).toMatch(/main\s*\{\s*color:\s*(rebeccapurple|#639)/);
    expect(css(result)).not.toContain("box-sizing: border-box");
  });

  it("fails when index.html links a file that isn't in the Workspace", async () => {
    const result = await failed({ "index.html": page.replace("/src/client/main.tsx", "/src/client/missing.tsx") });
    expect(result.errors).toEqual([
      expect.objectContaining({ file: "index.html", message: expect.stringContaining("/src/client/missing.tsx") }),
    ]);
  });
});

describe("the Worker + React Template", () => {
  it("makes a Workspace with a clean Check that builds and shows a styled page in the Preview", async () => {
    const workspace = await create("React Notes", undefined, "worker-react");
    // Packed once for both Templates, and joined back on.
    const types = await (await call(`/api/workspaces/${workspace.id}/files/worker-configuration.d.ts`)).text();
    expect(types).toMatch(/^\/\* eslint-disable \*\/[^]*mainModule: typeof import\("\.\/src\/server\/index"\)[^]*\/\/ Begin runtime types\n/);
    const check = await (await call(`/api/workspaces/${workspace.id}/check`, { method: "POST" })).json<CheckReport>();
    expect(check.problems).toEqual([]);
    expect(check.projects).toEqual(["tsconfig.server.json", "tsconfig.client.json"]);
    const report = await (await call(`/api/workspaces/${workspace.id}/build`, { method: "POST" })).json<BuildReport>();
    expect(report).toMatchObject({ ok: true, errors: [] });

    const preview = env.WORKSPACES.getByName(workspace.id);
    const page = await preview.requestPreview({ method: "GET", path: "/" });
    expect(page.body).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(page.body).toContain('<script type="module" src="/client/main.js"></script>');
    const styles = await preview.requestPreview({ method: "GET", path: "/styles.css" });
    expect(styles.truncated).toBe(false);
    for (const rule of [".bg-slate-50", ".bg-sky-600", ".hover\\:bg-sky-700", ".text-4xl", ".min-h-screen"]) {
      expect(styles.body).toContain(rule);
    }
    const script = await preview.requestPreview({ method: "GET", path: "/client/main.js" });
    expect(script.body).toContain("Your app");
    const api = await preview.requestPreview({ method: "GET", path: "/api/hello/React" });
    expect(JSON.parse(api.body)).toEqual({ message: "Hello, React" });
    expect((await preview.requestPreview({ method: "GET", path: "/favicon.svg" })).body).toContain("<svg");

    // Its tests: App rendered to HTML, and the Worker's routes.
    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`, { method: "POST" })).json<TestReport>();
    expect(tests.bundleErrors).toEqual([]);
    expect(tests.files.map(({ file, tests, errors }) => [file, tests.map(({ state }) => state), errors])).toEqual([
      ["src/client/App.test.tsx", ["passed"], []],
      ["src/server/index.test.ts", ["passed"], []],
    ]);
  });
});
