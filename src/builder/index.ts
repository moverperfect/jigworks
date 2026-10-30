import { createApp, createWorker, type Modules } from "@cloudflare/worker-bundler";
import { init as initLexer, parse } from "es-module-lexer/js";
import type { BuildProblem } from "../shared/build-report";
import { parseJsonc } from "../shared/jsonc";
import { compileTailwind, outputPath, readPage, tailwindVersion, usesTailwind } from "./front-end";

export type { BuildProblem };

/** A Workspace's files and Packages: path relative to the Workspace root, to text. */
export type Snapshot = ReadonlyMap<string, string>;

/**
 * How the app host serves a Build's assets, from `assets` in `wrangler.jsonc`,
 * as Cloudflare does: requests that match an asset get it, unless they match
 * `runWorkerFirst`; with `single-page-application`, other page navigations get
 * `/index.html`; everything else goes to the Worker.
 */
export interface AssetSettings {
  notFoundHandling: "single-page-application" | "none";
  /** True, or path patterns such as `/api/*`; a pattern starting `!` excludes. */
  runWorkerFirst: boolean | string[];
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
  /** Pathname to content, which the app host serves in front of the Worker. Empty without a front end. */
  assets: Record<string, string>;
  /** Pathname to each asset's content type, if the bundler knows it, and ETag. */
  assetManifest: Record<string, { contentType?: string; etag: string }>;
  assetSettings: AssetSettings;
  /** How many possible class names the Tailwind step was given, if it ran. */
  tailwindCandidates?: number;
  warnings: BuildProblem[];
}

export interface BuildFailure {
  ok: false;
  hash: string;
  errors: BuildProblem[];
  warnings: BuildProblem[];
  /** Packages the output still imports, which the bundler leaves in place without a word. Counted for the findings. */
  missingPackages: string[];
  /**
   * Why the Tailwind step failed, counted for the findings: something the
   * platform's Tailwind doesn't support, or an error in the CSS.
   */
  tailwindFailure?: "unsupported" | "error";
}

export type BuildResult = Build | BuildFailure;

/**
 * What the Workspace builds with. It runs in the Workspace's own isolate for
 * now; a Dynamic Worker could provide it instead if memory runs short
 * (ADR 0010).
 */
export interface Builder {
  /** Builds, or reuses a recent Build of the same inputs. */
  build(snapshot: Snapshot): Promise<BuildResult & { cached: boolean }>;
}

// Enough to go back and forth between two versions without rebuilding. The
// app host keeps Builds for good (ADR 0009).
const cachedBuilds = 4;

/** A Builder in this isolate, which keeps its last few Builds by their inputs' hash. */
export function inProcessBuilder(): Builder {
  const recent = new Map<string, BuildResult>();
  return {
    async build(snapshot) {
      const hash = await hashOf(snapshot);
      const cached = recent.get(hash);
      if (cached) {
        recent.delete(hash);
        recent.set(hash, cached);
        return { ...cached, cached: true };
      }
      const result = await build(snapshot);
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
 * With an `index.html`, the Build has a front end too (see `front-end.ts`).
 */
export async function build(snapshot: Snapshot): Promise<BuildResult> {
  const hash = await hashOf(snapshot);
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
    assets?: { not_found_handling?: unknown; run_worker_first?: unknown };
  };

  let mainModule: string;
  let modules: Modules;
  let warningTexts: string[];
  let assets: Record<string, string> = {};
  let assetManifest: Build["assetManifest"] = {};
  let clientBundles: string[] = [];
  let tailwindCandidates: number | undefined;
  try {
    if (snapshot.has("index.html")) {
      const page = await readPage(snapshot);
      if (page.problems.length > 0) return { ok: false, hash, errors: page.problems, warnings: [], missingPackages: [] };
      const compiled: Record<string, string> = {};
      const plain: string[] = [];
      for (const stylesheet of page.stylesheets) {
        if (!usesTailwind(stylesheet, snapshot)) {
          plain.push(stylesheet);
          continue;
        }
        const result = await compileTailwind(stylesheet, snapshot);
        if ("problems" in result) {
          return { ok: false, hash, errors: result.problems, warnings: [], missingPackages: [], tailwindFailure: result.failure };
        }
        compiled[outputPath(stylesheet)] = result.css;
        tailwindCandidates = result.candidates;
      }
      const app = await createApp({
        files,
        client: [...page.scripts, ...plain],
        assets: { ...publicAssets(snapshot), "/index.html": page.html, ...compiled },
        jsx: "automatic",
        jsxImportSource: "react",
        minify: true,
      });
      ({ mainModule, modules } = app);
      // Only text goes in: the Workspace's files and the bundles.
      assets = app.assets as Record<string, string>;
      assetManifest = Object.fromEntries(app.assetManifest);
      warningTexts = app.warnings ?? [];
      clientBundles = (app.clientBundles ?? []).filter((path) => !path.endsWith(".css"));
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
    assetSettings: assetSettings(config.assets),
    ...(tailwindCandidates === undefined ? {} : { tailwindCandidates }),
    warnings,
  };
}

/** Each file under `public/`, at its path below it. */
function publicAssets(snapshot: Snapshot): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const [path, text] of snapshot) if (path.startsWith("public/")) assets[`/${path.slice("public/".length)}`] = text;
  return assets;
}

/** `assets` from `wrangler.jsonc`, with Cloudflare's defaults. Anything the app host can't do is left at its default. */
function assetSettings(assets: { not_found_handling?: unknown; run_worker_first?: unknown } = {}): AssetSettings {
  const first = assets.run_worker_first;
  return {
    notFoundHandling: assets.not_found_handling === "single-page-application" ? "single-page-application" : "none",
    runWorkerFirst:
      typeof first === "boolean" ? first : Array.isArray(first) ? first.filter((pattern) => typeof pattern === "string") : false,
  };
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

async function hashOf(snapshot: Snapshot): Promise<string> {
  const encoder = new TextEncoder();
  // The same files make a different Build after a Tailwind upgrade.
  const parts = [`tailwindcss ${tailwindVersion}`];
  for (const path of [...snapshot.keys()].sort()) parts.push(path, snapshot.get(path)!);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("\0")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
