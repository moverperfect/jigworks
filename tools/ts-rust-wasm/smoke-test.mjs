// Checks a vendored ts-rust-wasm build: a tiny project with one deliberate
// type error must give exactly that error.
// usage: node tools/ts-rust-wasm/smoke-test.mjs
import assert from "node:assert/strict";
import { tsc } from "../../vendor/ts-rust-wasm/node.js";

const { exitCode, diagnostics } = await tsc(["-p", "/app", "--noEmit"], {
  files: {
    "/app/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022" } }),
    "/app/index.ts": "export const ok: number = 1;\nexport const wrong: number = 'one';\n",
  },
  diagnostics: "json",
});

assert.equal(diagnostics.length, 1, `expected 1 diagnostic, got ${JSON.stringify(diagnostics, null, 2)}`);
const [d] = diagnostics;
assert.equal(d.fileName, "/app/index.ts");
assert.equal(d.code, 2322);
assert.notEqual(exitCode, 0);
console.log(`ok: TS${d.code} in ${d.fileName}: ${d.text}`);
