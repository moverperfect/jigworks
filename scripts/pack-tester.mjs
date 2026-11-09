// Bundles the Tester's Dynamic Worker (src/tester/worker.ts), with the
// vitest parts it's built from, into src/generated/tester-worker.txt, one ES
// module that the platform passes to the Worker Loader as text (ADR 0017).
// The tests' own bundle is passed alongside it.
//
// Also bundles the Test bundler's Dynamic Worker (src/tester/bundler.ts),
// with worker-bundler, into src/generated/test-bundler.txt, and the Builder's
// (src/builder/worker.ts), with Tailwind too, into
// src/generated/builder-worker.txt. esbuild's compiled module is passed
// alongside each, as `esbuild.wasm`. As for the Checker, each bundle's first
// line records the module's SHA-256, so the bundle, and the Dynamic Worker ID
// made from it, change whenever esbuild does.
//
// Also packs the types the Check gives the tests' `vitest`, as JSON in
// src/generated/vitest-types.txt: each path under node_modules/, to its text.
// They're src/tester/types/vitest.d.ts as vitest's index.d.ts, with the
// declarations of the parts it's built from and their dependencies.
// usage: node scripts/pack-tester.mjs
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const outfile = fileURLToPath(new URL("../src/generated/tester-worker.txt", import.meta.url));

mkdirSync(fileURLToPath(new URL("../src/generated", import.meta.url)), { recursive: true });
await build({
  absWorkingDir: repo,
  entryPoints: ["src/tester/worker.ts"],
  outfile,
  bundle: true,
  format: "esm",
  // vitest's parts have browser builds, and fake timers' leaves out Node's timers.
  platform: "browser",
  target: "es2024",
  minify: true,
  external: ["cloudflare:workers"],
  plugins: [utilShim()],
  logLevel: "warning",
});
console.log(`wrote src/generated/tester-worker.txt (${(statSync(outfile).size / 1e3).toFixed(1)} kB)`);

// The Test bundler and the Builder (src/builder/worker.ts) both run esbuild in
// a Dynamic Worker of their own, and are packed alike.
const esbuildWasm = readFileSync(join(repo, "node_modules/@cloudflare/worker-bundler/dist/esbuild.wasm"));
for (const [entry, name] of [
  ["src/tester/bundler.ts", "test-bundler.txt"],
  ["src/builder/worker.ts", "builder-worker.txt"],
]) {
  const file = fileURLToPath(new URL(`../src/generated/${name}`, import.meta.url));
  await build({
    banner: { js: `// esbuild.wasm sha256 ${createHash("sha256").update(esbuildWasm).digest("hex")}` },
    absWorkingDir: repo,
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    minify: true,
    external: ["cloudflare:workers"],
    // The Builder takes Tailwind's packed stylesheets in (scripts/pack-tailwind.mjs runs first).
    loader: { ".txt": "text" },
    plugins: [esbuildWasmFromHost()],
    logLevel: "warning",
  });
  writeFileSync(file, withGoGc(readFileSync(file, "utf8")));
  console.log(`wrote src/generated/${name} (${(statSync(file).size / 1e3).toFixed(1)} kB)`);
}

const typesFile = fileURLToPath(new URL("../src/generated/vitest-types.txt", import.meta.url));
const types = {
  "node_modules/vitest/package.json": JSON.stringify({ name: "vitest", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts" } } }),
  "node_modules/vitest/index.d.ts": readFileSync(join(repo, "src/tester/types/vitest.d.ts"), "utf8"),
};
const packed = new Set();
const pack = (name, from) => {
  const dir = packageDir(name, from);
  if (!dir || packed.has(dir)) return;
  packed.add(dir);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declarations = declarationsIn(dir);
  if (declarations.length > 0) {
    const { version, type, types: typesEntry, typings, main, exports } = manifest;
    types[`node_modules/${name}/package.json`] = JSON.stringify({ name, version, type, types: typesEntry, typings, main, exports });
    for (const path of declarations) types[`node_modules/${name}/${relative(dir, path)}`] = readFileSync(path, "utf8");
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) pack(dependency, dir);
};
for (const part of ["@vitest/runner", "@vitest/expect", "@vitest/spy"]) pack(part, repo);
writeFileSync(typesFile, JSON.stringify(types));
console.log(`wrote src/generated/vitest-types.txt (${Object.keys(types).length} files, ${(statSync(typesFile).size / 1e3).toFixed(1)} kB)`);

/** Where Node would find a package from a directory, following pnpm's links. */
function packageDir(name, from) {
  for (let dir = realpathSync(from); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = basename(dir) === "node_modules" ? join(dir, name) : join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
  return null;
}

/** A package's declaration files, outside its own node_modules. */
function declarationsIn(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((path) => /\.d\.[cm]?ts$/.test(path) && !path.split("/").includes("node_modules"))
    .map((path) => join(dir, path));
}

/**
 * Starts esbuild's Go runtime with `GOGC=25`, so its heap grows to 1.25
 * times what's live before it collects, not twice. esbuild's linear memory
 * never shrinks, so that's its peak: a small app with a UI kit's Packages
 * went from 111 MB to 82 MB, against an isolate's 128 MB (#99,
 * docs/findings.md). esbuild's browser build gives Go an empty environment,
 * so the bundle is patched; a new esbuild that fails the match fails here.
 */
function withGoGc(code) {
  const empty = 'this.argv=["js"],this.env={}';
  if (code.split(empty).length !== 2) throw new Error(`Expected esbuild's Go runtime to set its environment once, as ${empty}`);
  return code.replace(empty, 'this.argv=["js"],this.env={GOGC:"25"}');
}

/** worker-bundler imports esbuild's compiled module, which the host passes in as a module of the same name. */
function esbuildWasmFromHost() {
  return {
    name: "esbuild-wasm-from-host",
    setup(build) {
      build.onResolve({ filter: /\/esbuild\.wasm$/ }, () => ({ path: "./esbuild.wasm", external: true }));
    },
  };
}

/**
 * Fake timers read `util.promisify.custom` when there's a `process`, as
 * there is with `nodejs_compat`, to make `promisify(setTimeout)` work. That's
 * all they take from `util`, and it's the same symbol everywhere.
 */
function utilShim() {
  return {
    name: "util-shim",
    setup(build) {
      build.onResolve({ filter: /^util$/ }, () => ({ path: "util", namespace: "util-shim" }));
      build.onLoad({ filter: /.*/, namespace: "util-shim" }, () => ({
        contents: 'export const promisify = { custom: Symbol.for("nodejs.util.promisify.custom") };',
        loader: "js",
      }));
    },
  };
}
