import { describe, expect, it } from "vitest";
import { build, type Build, type BuildFailure } from "../src/builder";

// Builds with a front end: index.html names the scripts and stylesheets the
// Build bundles, and a stylesheet that imports tailwindcss goes through the
// platform's Tailwind step (ADR 0007).

// Just enough of React for esbuild's automatic JSX runtime.
const react = {
  "node_modules/react/package.json": JSON.stringify({
    name: "react",
    version: "19.3.1",
    exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" },
  }),
  "node_modules/react/index.js": "export const version = '19.3.1';\n",
  "node_modules/react/jsx-runtime.js":
    "export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;\nexport const Fragment = 'fragment';\n",
};

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

const css = (result: Build) => result.assets["/styles.css"] as string;

describe("a Build with a front end", () => {
  it("bundles the scripts and stylesheets index.html links, and points index.html at them", async () => {
    const result = await built({});
    const html = result.assets["/index.html"] as string;
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
        "  </main>",
        ");",
        "",
      ].join("\n"),
    });
    for (const rule of [".flex", ".hover\\:underline", ".bg-sky-500", ".p-\\[13px\\]", ".md\\:grid", ".text-sm\\/6"]) {
      expect(css(result)).toContain(rule);
    }
    expect(css(result)).not.toContain(".bg-red-500");
    // Tailwind's own reset comes with it.
    expect(css(result)).toContain("box-sizing: border-box");
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
    expect(plugin.tailwindFailed).toBe(true);

    const config = await failed({
      "src/styles.css": '@import "tailwindcss";\n@import "./more.css";\n',
      "src/more.css": '/* @plugin in a comment is fine */\n@config "../tailwind.config.js";\n',
    });
    expect(config.errors).toEqual([
      expect.objectContaining({ file: "src/more.css", line: 2, message: expect.stringContaining("@config") }),
    ]);
  });

  it("reports Tailwind's own errors as Build errors", async () => {
    const result = await failed({ "src/styles.css": '@import "tailwindcss";\n.card { @apply not-a-utility; }\n' });
    expect(result.errors).toEqual([
      expect.objectContaining({ file: "src/styles.css", message: expect.stringContaining("not-a-utility") }),
    ]);
    expect(result.tailwindFailed).toBe(true);
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
