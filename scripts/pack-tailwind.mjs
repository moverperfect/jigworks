// Packs the stylesheets of the platform's one Tailwind version (ADR 0007) into
// src/generated/tailwind.txt: JSON of { version, stylesheets: { [name]: css } },
// where the name is the file's name in the tailwindcss package, such as
// "index.css". The Build serves them for `@import "tailwindcss"` and its parts.
// usage: node scripts/pack-tailwind.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("tailwindcss/package.json"));
const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const outFile = fileURLToPath(new URL("../src/generated/tailwind.txt", import.meta.url));

const stylesheets = Object.fromEntries(
  ["index.css", "theme.css", "preflight.css", "utilities.css"].map((name) => [name, readFileSync(join(packageDir, name), "utf8")]),
);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ version, stylesheets }));
console.log(`wrote src/generated/tailwind.txt (Tailwind ${version})`);
