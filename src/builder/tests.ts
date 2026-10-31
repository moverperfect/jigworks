// The tests' bundle (ADR 0017), made as a Build is. It runs in the Test
// bundler's Dynamic Worker, so esbuild's memory stays out of the Workspace's
// Durable Object (see src/tester/bundler.ts).
import { createWorker } from "@cloudflare/worker-bundler";
import { DecodedMap, getOriginalPosition } from "@vitest/utils/source-map";
import { init as initLexer } from "es-module-lexer/js";
import type { BuildProblem } from "../shared/build-report";
import { parseJsonc } from "../shared/jsonc";
import { bundlerFiles, esbuildProblems, missingImports, type Snapshot } from "./bundling";

/** The tests' bundle, for the Tester (ADR 0017). */
export interface TestBundle {
  ok: true;
  /** One ES module that exports `files`: each test file's path, to a function that imports it. */
  code: string;
  /** The bundle's source map, without the sources, which takes errors back to the Workspace's files. */
  sourceMap: string;
  compatibilityDate: string | undefined;
  compatibilityFlags: string[];
}

export type TestBundleResult = TestBundle | { ok: false; errors: BuildProblem[] };

// The bundle's entry, made by the platform.
const testsEntry = "__jigworks-tests.js";
const inlineSourceMap = "\n//# sourceMappingURL=data:application/json;base64,";

/**
 * Bundles a snapshot's test files into one module, as a Build bundles the
 * app. Each file is imported only when the Tester asks for it, inside its
 * call, where Workers allow timers and randomness. `virtualModules` gives the
 * tests the platform's `vitest`.
 */
export async function bundleTests(snapshot: Snapshot, testFiles: string[], virtualModules: Record<string, string>): Promise<TestBundleResult> {
  const files = bundlerFiles(snapshot);
  files[testsEntry] = `export const files = {\n${testFiles
    .map((path) => `  ${JSON.stringify(path)}: () => import(${JSON.stringify(`./${path}`)}),`)
    .join("\n")}\n};\n`;
  const config = (parseJsonc(snapshot.get("wrangler.jsonc") ?? "{}") ?? {}) as { compatibility_date?: string; compatibility_flags?: string[] };
  let code: string;
  try {
    const worker = await createWorker({
      files,
      entryPoint: testsEntry,
      virtualModules,
      jsx: "automatic",
      jsxImportSource: "react",
      sourcemap: true,
    });
    const main = worker.modules[worker.mainModule];
    code = typeof main === "string" ? main : (main?.js ?? "");
  } catch (error) {
    return { ok: false, errors: esbuildProblems(error) };
  }
  await initLexer();
  const at = code.lastIndexOf(inlineSourceMap);
  // The Tester needs only the mappings, so the sources, most of the map, go.
  const { sourcesContent: _, ...sourceMap } = at === -1 ? {} : JSON.parse(fromBase64(code.slice(at + inlineSourceMap.length).trim()));
  // The bundle is one module, so a relative import left in it wasn't found either.
  const missing = missingImports(code, { relative: true });
  if (missing.length > 0) {
    const map = new DecodedMap(sourceMap, "/");
    return {
      ok: false,
      errors: missing.map((specifier) => ({
        message: `The tests import "${specifier}", which isn't in the Workspace or its Packages`,
        ...placeInBundle(code, code.indexOf(JSON.stringify(specifier)), map),
      })),
    };
  }
  return {
    ok: true,
    code: at === -1 ? code : code.slice(0, at),
    sourceMap: JSON.stringify(sourceMap),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
  };
}

function fromBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Which Workspace file, and where in it, the bundle's text at `offset` came from, by its source map. */
function placeInBundle(code: string, offset: number, map: DecodedMap): Pick<BuildProblem, "file" | "line" | "column"> {
  const before = code.slice(0, Math.max(offset, 0));
  const lineStart = before.lastIndexOf("\n") + 1;
  const original = offset < 0 ? null : getOriginalPosition(map, { line: before.split("\n").length, column: offset - lineStart });
  const file = original?.source?.replace(/^.*virtual:\/?/, "");
  return original && file && original.line !== null
    ? { file, line: original.line, column: original.column + 1 }
    : { file: null, line: null, column: null };
}
