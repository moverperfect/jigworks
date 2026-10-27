// Writes NOTICE.md: the third-party code that Jigworks ships, with each
// package's licence text. It lists what the bundles actually contain, read from
// their source maps, rather than every dependency installed: some installed
// packages, such as just-bash's native helpers, never reach a bundle.
// usage: pnpm generate && pnpm --filter client build && node scripts/write-notice.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
if (!existsSync(join(root, "client/dist")) || !existsSync(join(root, "src/generated"))) {
  console.error("Run `pnpm generate && pnpm --filter client build` first: the Worker's dry run needs both.");
  process.exit(1);
}
const out = mkdtempSync(join(tmpdir(), "jigworks-notice-"));
const quiet = { stdio: ["ignore", "ignore", "inherit"] };

// The platform Worker, exactly as `wrangler deploy` would upload it.
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(out, "worker")], { cwd: root, ...quiet });
// The pages, built with source maps so that their modules can be named.
execFileSync("npx", ["vite", "build", "--sourcemap", "--outDir", join(out, "client"), "--emptyOutDir"], {
  cwd: join(root, "client"),
  ...quiet,
});

/** Each package a directory's source maps draw on, as `name@version` → where it's installed. */
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
      if (!found.has(key)) found.set(key, join(root, "node_modules/.pnpm", pnpmDir, "node_modules", name));
    }
  }
  return found;
}

/** A package's name, version, licence name and licence text. */
function describe(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenceFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying)(\.|$)/i.test(file));
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const text = licenceFile
    ? readFileSync(join(dir, licenceFile), "utf8").trim()
    : `The package doesn't include its licence text. Its licence is ${manifest.license}; see ${repository ?? "its source"}.`;
  return { name: manifest.name, version: manifest.version, licence: manifest.license ?? "see below", text };
}

const worker = [...bundledPackages(join(out, "worker")).values()].map(describe);
const pages = [...bundledPackages(join(out, "client")).values()].map(describe);
rmSync(out, { recursive: true, force: true });

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
const table = (packages) =>
  ["| Package | Version | Licence |", "| --- | --- | --- |"]
    .concat(packages.sort(byName).map((p) => `| \`${p.name}\` | ${p.version} | ${p.licence} |`))
    .join("\n");
const all = new Map([...worker, ...pages].map((p) => [`${p.name}@${p.version}`, p]));
const texts = [...all.values()]
  .sort(byName)
  .map((p) => `### ${p.name} ${p.version}\n\n\`\`\`text\n${p.text}\n\`\`\``)
  .join("\n\n");

const notice = `# Notice

Jigworks ships third-party code, and each part keeps its own licence. Jigworks' own licence is in \`LICENSE.md\`. This file is written by \`scripts/write-notice.mjs\`; run it again after changing dependencies. The platform's pages serve it as \`/third-party-licences.md\`.

## ts-rust

The Checker runs ts-rust's WebAssembly module (\`vendor/ts-rust-wasm\`): MIT, copyright T3 Tools Inc. The module includes code from TypeScript (Apache-2.0, with its \`NOTICE\`), Go (BSD-3-Clause), Unicode data (Unicode License v3) and vscode-languageserver-node (MIT). Those licences, and TypeScript's \`NOTICE\`, are in \`vendor/ts-rust-wasm/licenses/\`.

## Bundled into the platform Worker

${table(worker)}

## Bundled into the platform's pages

${table(pages)}

## Licence texts

${texts}
`;
writeFileSync(join(root, "NOTICE.md"), notice);
// The copy the pages serve, so a deploy without another client build isn't stale.
writeFileSync(join(root, "client/dist/third-party-licences.md"), notice);
console.log(`wrote NOTICE.md: ${worker.length} packages in the Worker, ${pages.length} in the pages`);
