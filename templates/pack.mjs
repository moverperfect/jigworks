// Packs each Template under templates/, and each add-on under addons/, into
// src/generated/templates.txt: JSON of { runtimeTypes, templates, addons },
// keyed by folder name (see src/templates/pack.ts, which does the packing).
// A Template's template.json, and an add-on's addon.json and notes.md, aren't
// files copied into Workspaces, so they aren't among the files. The runtime
// types that end every worker-configuration.d.ts are the same in each
// Template, and 600 KB, so they're packed once and joined back on
// (src/templates/index.ts).
// usage: node templates/pack.mjs
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "../src/templates/pack.ts";

const templatesDir = fileURLToPath(new URL(".", import.meta.url));
const root = join(templatesDir, "..");
const addonsDir = join(root, "addons");
const outFile = join(root, "src", "generated", "templates.txt");

const posix = (path) => path.split(sep).join("/");
const read = (path) => readFileSync(path, "utf8");

/** Each folder in `dir`, by name, with its files other than `own`, which it reads with `readOwn`. */
const folders = (dir, own, readOwn) => {
  const found = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = join(dir, entry.name);
    const files = {};
    for (const file of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const path = posix(relative(folder, join(file.parentPath, file.name)));
      if (!own.includes(path)) files[path] = read(join(folder, path));
    }
    found[entry.name] = { ...readOwn(folder), files };
  }
  return found;
};

const packed = pack(
  folders(templatesDir, ["template.json"], (folder) => ({ manifest: JSON.parse(read(join(folder, "template.json"))) })),
  folders(addonsDir, ["addon.json", "notes.md"], (folder) => ({
    manifest: JSON.parse(read(join(folder, "addon.json"))),
    notes: read(join(folder, "notes.md")),
  })),
);

const kB = (files) => (Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0) / 1e3).toFixed(1);
for (const [id, { name, files }] of Object.entries(packed.templates)) {
  console.log(`${id}: "${name}", ${Object.keys(files).length} files, ${kB(files)} kB`);
}
for (const [id, { name, files }] of Object.entries(packed.addons)) {
  console.log(`add-on ${id}: "${name}", ${Object.keys(files).length} files, ${kB(files)} kB`);
}
console.log(`runtime types: ${(Buffer.byteLength(packed.runtimeTypes) / 1e3).toFixed(1)} kB, packed once`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(packed));
console.log(`wrote ${posix(relative(root, outFile))}`);
