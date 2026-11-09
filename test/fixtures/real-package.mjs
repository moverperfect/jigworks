import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read under Node by vitest.config.ts (see real-package.d.mts for its type), so the fake registry can serve a real
// Package: the platform's own copy, cut down to the files its `entries` import.

const imports = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;

/**
 * The installed Package `name`, as the fake registry publishes it: its
 * `exports` cut down to `entries` (such as `"."` and `"./cookie"`), with the
 * scripts and types those import, its README, and a package.json exporting
 * only those entries.
 */
export function realPackage(name, entries) {
  // One of the platform's own dependencies, so pnpm links it at the top of node_modules.
  const root = fileURLToPath(new URL(`../../node_modules/${name}/`, import.meta.url));
  const read = (path) => readFileSync(join(root, path), "utf8");
  const manifest = JSON.parse(read("package.json"));
  const files = { "README.md": read("README.md") };

  const add = (path) => {
    if (path in files) return;
    const text = read(path);
    files[path] = text;
    for (const [, specifier] of text.matchAll(imports)) {
      const target = join(dirname(path), specifier);
      const candidates = path.endsWith(".d.ts")
        ? [target.replace(/\.js$/, ".d.ts"), `${target}.d.ts`, join(target, "index.d.ts")]
        : [target, `${target}.js`, join(target, "index.js")];
      const found = candidates.find((candidate) => existsSync(join(root, candidate)) && candidate.match(/\.(js|d\.ts)$/));
      if (!found) throw new Error(`${name}'s ${path} imports ${specifier}, which isn't there.`);
      add(found);
    }
  };
  const exports = {};
  for (const entry of entries) {
    const { types, import: script } = manifest.exports[entry];
    exports[entry] = { types, import: script };
    add(types.replace(/^\.\//, ""));
    add(script.replace(/^\.\//, ""));
  }
  const { version, type } = manifest;
  files["package.json"] = JSON.stringify({ name, version, type, exports });
  return { name, versions: { [version]: { ageHours: 240, files } } };
}
