import {
  createApp,
  createWorker,
  type AssetConfig,
  type AssetManifest,
  type Modules,
} from "@cloudflare/worker-bundler";
import { init as initLexer, parse } from "es-module-lexer/js";
import type { BuildProblem } from "../shared/build-report";
import { parseJsonc } from "../shared/jsonc";

export type { BuildProblem };

/** A Workspace's files and Packages: path relative to the Workspace root, to text. */
export type Snapshot = ReadonlyMap<string, string>;

export interface BuildOptions {
  /**
   * Browser entry points, such as `src/client/main.tsx`. With any, the Build
   * also bundles them, and serves `index.html` and `public/` as assets.
   */
  client?: string[];
}

export interface Build {
  ok: true;
  /** SHA-256 of the inputs, usable as a cache key and a Dynamic Worker ID. */
  hash: string;
  mainModule: string;
  modules: Modules;
  compatibilityDate: string | undefined;
  compatibilityFlags: string[];
  /** Plain-text `vars` from `wrangler.jsonc`. */
  vars: Record<string, string>;
  /** Pathname to content, served by the host in front of the Worker. */
  assets: Record<string, string | ArrayBuffer>;
  assetManifest: AssetManifest | undefined;
  assetConfig: AssetConfig | undefined;
  warnings: BuildProblem[];
}

export interface BuildFailure {
  ok: false;
  hash: string;
  errors: BuildProblem[];
  warnings: BuildProblem[];
  /** Packages the output still imports, which the bundler leaves in place without a word. Counted for the findings. */
  missingPackages: string[];
}

export type BuildResult = Build | BuildFailure;

/**
 * What the Workspace builds with. It runs in the Workspace's own isolate for
 * now; a Dynamic Worker could provide it instead if memory runs short
 * (ADR 0010).
 */
export interface Builder {
  /** Builds, or reuses a recent Build of the same inputs. */
  build(snapshot: Snapshot, options?: BuildOptions): Promise<BuildResult & { cached: boolean }>;
}

// Enough to go back and forth between two versions without rebuilding. The
// app host keeps Builds for good (ADR 0009).
const cachedBuilds = 4;

/** A Builder in this isolate, which keeps its last few Builds by their inputs' hash. */
export function inProcessBuilder(): Builder {
  const recent = new Map<string, BuildResult>();
  return {
    async build(snapshot, options = {}) {
      const hash = await hashOf(snapshot, options);
      const cached = recent.get(hash);
      if (cached) {
        recent.delete(hash);
        recent.set(hash, cached);
        return { ...cached, cached: true };
      }
      const result = await build(snapshot, options);
      recent.set(hash, result);
      if (recent.size > cachedBuilds) recent.delete(recent.keys().next().value!);
      return { ...result, cached: false };
    },
  };
}

/**
 * Builds a snapshot with `@cloudflare/worker-bundler`, unmodified. Every
 * Package must already be in the snapshot under `node_modules/`. A Build
 * fails if its output still imports a package the bundler couldn't find,
 * because the bundler otherwise leaves those imports in place without a word.
 */
export async function build(snapshot: Snapshot, options: BuildOptions = {}): Promise<BuildResult> {
  const hash = await hashOf(snapshot, options);
  const files = Object.fromEntries(snapshot);
  // The bundler runs its own npm installer for any dependency it can't find
  // under node_modules/, which would skip the platform's Package rules: the
  // one-day minimum age, and one version of each Package. So it isn't told
  // about any. The Packages are already in the snapshot.
  if (files["package.json"] !== undefined) files["package.json"] = withoutDependencies(files["package.json"]);
  const config = (parseJsonc(snapshot.get("wrangler.jsonc") ?? "{}") ?? {}) as {
    compatibility_date?: string;
    compatibility_flags?: string[];
    vars?: Record<string, unknown>;
  };

  let mainModule: string;
  let modules: Modules;
  let warningTexts: string[];
  let assets: Record<string, string | ArrayBuffer> = {};
  let assetManifest: AssetManifest | undefined;
  let assetConfig: AssetConfig | undefined;
  let clientBundles: string[] = [];
  try {
    if (options.client?.length) {
      const app = await createApp({
        files,
        client: options.client,
        assets: staticAssets(snapshot),
        assetConfig: { not_found_handling: "single-page-application" },
        jsx: "automatic",
        jsxImportSource: "react",
        minify: true,
      });
      ({ mainModule, modules, assets, assetManifest, assetConfig } = app);
      warningTexts = app.warnings ?? [];
      clientBundles = app.clientBundles ?? [];
    } else {
      const worker = await createWorker({ files });
      ({ mainModule, modules } = worker);
      warningTexts = worker.warnings ?? [];
    }
  } catch (error) {
    return { ok: false, hash, errors: esbuildProblems(error), warnings: [], missingPackages: [] };
  }
  const warnings = warningTexts.map(unplaced);

  await initLexer();
  const missing = [
    ...Object.entries(modules).flatMap(([name, module]) =>
      missingImports(typeof module === "string" ? module : (module.js ?? "")).map((specifier) => ({ name, specifier })),
    ),
    ...clientBundles.flatMap((path) => {
      const code = assets[path.startsWith("/") ? path : `/${path}`];
      return typeof code === "string" ? missingImports(code, { browser: true }).map((specifier) => ({ name: path, specifier })) : [];
    }),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      hash,
      errors: missing.map(({ name, specifier }) => unplaced(`${name} imports "${specifier}", which isn't in the Workspace's Packages`)),
      warnings,
      missingPackages: [...new Set(missing.map(({ specifier }) => specifier))],
    };
  }
  return {
    ok: true,
    hash,
    mainModule,
    modules,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    vars: Object.fromEntries(
      Object.entries(config.vars ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    assets,
    assetManifest,
    assetConfig,
    warnings,
  };
}

/** `index.html` at `/index.html`, and each file under `public/` at its path below it. */
function staticAssets(snapshot: Snapshot): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const [path, text] of snapshot) {
    if (path === "index.html") assets["/index.html"] = text;
    else if (path.startsWith("public/")) assets[`/${path.slice("public/".length)}`] = text;
  }
  return assets;
}

// Node's built-in modules, which `nodejs_compat` provides with or without
// the `node:` prefix.
const nodeBuiltins = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(
    " ",
  ),
);

/** Bare specifiers a bundle still imports or requires, other than the runtime's own. */
function missingImports(code: string, { browser = false } = {}): string[] {
  const specifiers = new Set<string>();
  try {
    const [imports] = parse(code);
    for (const { specifier } of imports) if (typeof specifier === "string") specifiers.add(specifier);
  } catch {
    // Not an ES module; only look for requires.
  }
  for (const match of code.matchAll(/\b__require\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]!);
  return [...specifiers].filter((specifier) => {
    if (/^(\.|\/|[a-z][a-z0-9+.-]*:\/\/|data:)/i.test(specifier)) return false;
    if (browser) return true;
    if (specifier.startsWith("cloudflare:") || specifier.startsWith("node:")) return false;
    return !nodeBuiltins.has(specifier.split("/")[0]!);
  });
}

/** esbuild's errors with their places: Workspace paths, 1-based lines and columns. */
function esbuildProblems(error: unknown): BuildProblem[] {
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

const unplaced = (message: string): BuildProblem => ({ message, file: null, line: null, column: null });

/** `package.json` without its dependencies, unless it isn't valid JSON, which the bundler ignores anyway. */
function withoutDependencies(packageJson: string): string {
  try {
    const { dependencies: _, ...rest } = JSON.parse(packageJson) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return packageJson;
  }
}

async function hashOf(snapshot: Snapshot, options: BuildOptions): Promise<string> {
  const encoder = new TextEncoder();
  const parts = [JSON.stringify(options)];
  for (const path of [...snapshot.keys()].sort()) parts.push(path, snapshot.get(path)!);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("\0")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
