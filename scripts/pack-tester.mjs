// Bundles the Tester's Dynamic Worker (src/tester/worker.ts), with the
// vitest parts it's built from, into src/generated/tester-worker.txt, one ES
// module that the platform passes to the Worker Loader as text (ADR 0017).
// The tests' own bundle is passed alongside it.
// usage: node scripts/pack-tester.mjs
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
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
