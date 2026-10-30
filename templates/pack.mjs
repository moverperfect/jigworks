// Packs each Template under templates/ into src/generated/templates.txt:
// JSON of { runtimeTypes, templates: { [id]: { name, description, files } } },
// where the id is the Template's folder name and files maps each path to its
// text. Its template.json gives the name and description and isn't copied
// into Workspaces, so it isn't among the files. The runtime types that end
// every worker-configuration.d.ts are the same in each Template, and 600 KB,
// so they're packed once and joined back on (src/templates/index.ts).
// usage: node templates/pack.mjs
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const templatesDir = fileURLToPath(new URL(".", import.meta.url));
const root = join(templatesDir, "..");
const outFile = join(root, "src", "generated", "templates.txt");

const posix = (path) => path.split(sep).join("/");

const runtimeTypesStart = "// Begin runtime types";
const typesFile = "worker-configuration.d.ts";
let runtimeTypes = "";

const templates = {};
for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  const templateDir = join(templatesDir, id);
  const { name, description } = JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));
  const files = {};
  for (const entry of readdirSync(templateDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const file = posix(relative(templateDir, path));
    if (file !== "template.json") files[file] = readFileSync(path, "utf8");
  }
  const start = files[typesFile]?.indexOf(runtimeTypesStart) ?? -1;
  if (start >= 0) {
    const types = files[typesFile].slice(start);
    if (runtimeTypes && types !== runtimeTypes) {
      throw new Error(`${id}'s runtime types differ from another Template's. Generate them with the same wrangler and compatibility date.`);
    }
    runtimeTypes = types;
    files[typesFile] = files[typesFile].slice(0, start);
  }
  templates[id] = { name, description, files };
  const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  console.log(`${id}: "${name}", ${Object.keys(files).length} files, ${(bytes / 1e3).toFixed(1)} kB`);
}

mkdirSync(dirname(outFile), { recursive: true });
console.log(`runtime types: ${(Buffer.byteLength(runtimeTypes) / 1e3).toFixed(1)} kB, packed once`);
writeFileSync(outFile, JSON.stringify({ runtimeTypes, templates }));
console.log(`wrote ${posix(relative(root, outFile))}`);
