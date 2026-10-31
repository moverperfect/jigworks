// What a Build and the tests' bundle share: the files the bundler is given,
// and how its output and errors are read.
import { parse } from "es-module-lexer/js";
import type { BuildProblem } from "../shared/build-report";

/** A Workspace's files and Packages: path relative to the Workspace root, to text. */
export type Snapshot = ReadonlyMap<string, string>;

/**
 * The snapshot as the bundler takes it. The bundler runs its own npm
 * installer for any dependency it can't find under node_modules/, which would
 * skip the platform's Package rules: the one-day minimum age, and one version
 * of each Package. So it isn't told about any; the Packages are already in
 * the snapshot. And it resolves a Package's exports as if for Node as well as
 * browsers, so a Package that lists a Node build first, as React's server
 * renderer does, would bring in code Workers can't run. Wrangler never uses
 * the `node` condition, so the Packages' package.json files lose it.
 */
export function bundlerFiles(snapshot: Snapshot): Record<string, string> {
  const files = Object.fromEntries(snapshot);
  if (files["package.json"] !== undefined) files["package.json"] = withoutDependencies(files["package.json"]);
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith("node_modules/") && path.endsWith("/package.json") && text.includes('"node"')) {
      files[path] = withoutNodeConditions(text);
    }
  }
  return files;
}

// Node's built-in modules, which `nodejs_compat` provides with or without
// the `node:` prefix.
const nodeBuiltins = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(
    " ",
  ),
);

/** Bare specifiers a bundle still imports or requires, other than the runtime's own, and relative ones if asked. */
export function missingImports(code: string, { browser = false, relative = false } = {}): string[] {
  const specifiers = new Set<string>();
  try {
    const [imports] = parse(code);
    for (const { specifier } of imports) if (typeof specifier === "string") specifiers.add(specifier);
  } catch {
    // Not an ES module; only look for requires.
  }
  for (const match of code.matchAll(/\b__require\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]!);
  return [...specifiers].filter((specifier) => {
    if (/^(\.|\/)/.test(specifier)) return relative;
    if (/^([a-z][a-z0-9+.-]*:\/\/|data:)/i.test(specifier)) return false;
    if (browser) return true;
    if (specifier.startsWith("cloudflare:") || specifier.startsWith("node:")) return false;
    return !nodeBuiltins.has(specifier.split("/")[0]!);
  });
}

/** esbuild's errors with their places: Workspace paths, 1-based lines and columns. */
export function esbuildProblems(error: unknown): BuildProblem[] {
  const details = (error as { errors?: { text?: string; location?: { file?: string; line?: number; column?: number } }[] })
    ?.errors;
  if (!Array.isArray(details) || details.length === 0) return [unplaced(error instanceof Error ? error.message : String(error))];
  return details.map(({ text, location }) =>
    location?.file
      ? {
          message: String(text),
          // worker-bundler names files `virtual:<path>`, and esbuild counts columns from 0.
          file: location.file.replace(/^virtual:\/?/, ""),
          line: location.line ?? null,
          column: location.column === undefined ? null : location.column + 1,
        }
      : unplaced(String(text)),
  );
}

export const unplaced = (message: string): BuildProblem => ({ message, file: null, line: null, column: null });

/** `package.json` without its dependencies, unless it isn't valid JSON, which the bundler ignores anyway. */
function withoutDependencies(packageJson: string): string {
  try {
    const { dependencies: _, ...rest } = JSON.parse(packageJson) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return packageJson;
  }
}

/** A package.json whose `exports` have no `node` conditions, unless it isn't valid JSON. */
function withoutNodeConditions(packageJson: string): string {
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "node")
        .map(([key, inner]) => [key, prune(inner)]),
    );
  };
  try {
    const manifest = JSON.parse(packageJson) as Record<string, unknown>;
    return manifest.exports === undefined ? packageJson : JSON.stringify({ ...manifest, exports: prune(manifest.exports) });
  } catch {
    return packageJson;
  }
}
