// Writes NOTICE.md: the third-party code that Jigworks ships, with each
// package's licence. It lists what the bundles actually contain, read from
// their source maps, rather than every dependency installed: some installed
// packages, such as just-bash's native helpers, never reach a bundle.
// usage: pnpm generate && node scripts/write-notice.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "jigworks-notice-"));

// The platform Worker, exactly as `wrangler deploy` would upload it.
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(out, "worker")], { cwd: root, stdio: "ignore" });
// The pages, built with source maps so that their modules can be named.
execFileSync("npx", ["vite", "build", "--sourcemap", "--outDir", join(out, "client"), "--emptyOutDir"], {
  cwd: join(root, "client"),
  stdio: "ignore",
});

/** Each package a directory's source maps draw on, as `name@version` → its package.json. */
function bundledPackages(dir) {
  const found = new Map();
  for (const file of readdirSync(dir, { recursive: true })) {
    if (!String(file).endsWith(".map")) continue;
    const { sources } = JSON.parse(readFileSync(join(dir, String(file)), "utf8"));
    for (const source of sources) {
      // Credit each file to the installed package that shipped it: pnpm names
      // its directory `<name>@<version>`, with peers after an underscore. A
      // path inside it can be one of that package's own sources, which
      // doesn't exist here.
      const pnpmDir = /node_modules\/\.pnpm\/([^/]+)\//.exec(source)?.[1];
      const spec = pnpmDir && /^((?:@[^+/]+\+)?[^@/]+)@(\d[^_]*)/.exec(pnpmDir);
      if (!spec) continue;
      const name = spec[1].replace("+", "/");
      const key = `${name}@${spec[2]}`;
      if (found.has(key)) continue;
      found.set(key, JSON.parse(readFileSync(join(root, "node_modules/.pnpm", pnpmDir, "node_modules", name, "package.json"), "utf8")));
    }
  }
  return found;
}

function table(packages) {
  const rows = [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `| \`${p.name}\` | ${p.version} | ${typeof p.license === "string" ? p.license : "see its package"} |`);
  return ["| Package | Version | Licence |", "| --- | --- | --- |", ...rows].join("\n");
}

const worker = bundledPackages(join(out, "worker"));
const client = bundledPackages(join(out, "client"));
rmSync(out, { recursive: true, force: true });

writeFileSync(
  join(root, "NOTICE.md"),
  `# Notice

Jigworks ships third-party code, and each part keeps its own licence. Jigworks' own licence is in \`LICENSE.md\`. This file is written by \`scripts/write-notice.mjs\`; run it again after changing dependencies.

## WebAssembly modules

- **ts-rust**, the Checker's type-checker (\`vendor/ts-rust-wasm\`): MIT, copyright T3 Tools Inc. It includes code from TypeScript (Apache-2.0, with its \`NOTICE\`), Go (BSD-3-Clause), Unicode data and vscode-languageserver-node (MIT). Their licences are in \`vendor/ts-rust-wasm/licenses/\`.
- **esbuild**, which the Builder runs through \`@cloudflare/worker-bundler\`: MIT.

## Bundled into the platform Worker

${table(worker)}

## Bundled into the platform's pages

${table(client)}
`,
);
console.log(`wrote NOTICE.md: ${worker.size} packages in the Worker, ${client.size} in the pages`);
