// Bundles the Checker's Dynamic Worker (src/checker/worker.ts) with ts-rust's
// host code into src/generated/checker-worker.txt, one ES module that the
// platform passes to the Worker Loader as text. ts-rust's compiled
// module is passed separately, as `ts_rust.wasm` (ADR 0010). The bundle's
// first line records the module's SHA-256, so the bundle, and the Dynamic
// Worker ID made from it, change whenever ts-rust does.
// usage: node scripts/pack-checker.mjs
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const outfile = fileURLToPath(new URL("../src/generated/checker-worker.txt", import.meta.url));
const wasm = readFileSync(fileURLToPath(new URL("../vendor/ts-rust-wasm/ts_rust.wasm", import.meta.url)));
const wasmSha = createHash("sha256").update(wasm).digest("hex");

mkdirSync(fileURLToPath(new URL("../src/generated", import.meta.url)), { recursive: true });
await build({
  banner: { js: `// ts-rust-wasm sha256 ${wasmSha}` },
  absWorkingDir: repo,
  entryPoints: ["src/checker/worker.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2024",
  external: ["cloudflare:workers", "./ts_rust.wasm"],
  logLevel: "warning",
});
console.log(`wrote src/generated/checker-worker.txt (${(statSync(outfile).size / 1e3).toFixed(1)} kB)`);
