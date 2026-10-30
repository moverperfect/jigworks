import { createApp, createWorker, type Modules } from "@cloudflare/worker-bundler";
import { init as initLexer, parse } from "es-module-lexer/js";
import type { BuildProblem } from "../shared/build-report";
import { parseJsonc } from "../shared/jsonc";
import { frontEnd, tailwindVersion, type TailwindFailure } from "./front-end";

export type { BuildProblem };

/** A Workspace's files and Packages: path relative to the Workspace root, to text. */
export type Snapshot = ReadonlyMap<string, string>;

/** The `assets` settings in `wrangler.jsonc` the app host follows (ADR 0014). */
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
  /** Each Durable Object binding in `wrangler.jsonc`, to the class it binds (ADR 0006). */
  durableObjects: Record<string, string>;
  warnings: BuildProblem[];
}

export interface BuildFailure {
  ok: false;
  hash: string;
  errors: BuildProblem[];
  warnings: BuildProblem[];
  /** Packages the output still imports, which the bundler leaves in place without a word. Counted for the findings. */
  missingPackages: string[];
  /** Why the Tailwind step failed, if it did, counted for the findings. */
  tailwindFailure?: TailwindFailure;
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
    assets?: WranglerAssets;
    main?: string;
  };
  // The bindings' problems come with any others, so the Agent sees them all at once.
  const bindings = durableObjectBindings(config);
  const fail = (errors: BuildProblem[], more: Partial<BuildFailure> = {}): BuildFailure => ({
    ok: false,
    hash,
    warnings: [],
    missingPackages: [],
    ...more,
    errors: [...bindings.problems, ...errors],
  });

  let mainModule: string;
  let modules: Modules;
  let warningTexts: string[];
  let assets: Record<string, string> = {};
  let assetManifest: Build["assetManifest"] = {};
  let clientBundles: string[] = [];
  let tailwindCandidates: number | undefined;
  try {
    if (snapshot.has("index.html")) {
      const front = await frontEnd(snapshot);
      if (!front.ok) {
        return fail(front.problems, { tailwindFailure: front.tailwindFailure });
      }
      const app = await createApp({
        files,
        client: front.entries,
        assets: { ...publicAssets(snapshot), "/index.html": front.html, ...front.compiled },
        jsx: "automatic",
        jsxImportSource: "react",
        minify: true,
      });
      ({ mainModule, modules } = app);
      // Only text goes in: the Workspace's files and the bundler's output.
      assets = app.assets as Record<string, string>;
      assetManifest = Object.fromEntries(app.assetManifest);
      warningTexts = app.warnings ?? [];
      clientBundles = (app.clientBundles ?? []).filter((path) => !path.endsWith(".css"));
      tailwindCandidates = front.tailwindCandidates;
    } else {
      const worker = await createWorker({ files });
      ({ mainModule, modules } = worker);
      warningTexts = worker.warnings ?? [];
    }
  } catch (error) {
    return fail(esbuildProblems(error));
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
    return fail(
      missing.map(({ name, specifier }) => unplaced(`${name} imports "${specifier}", which isn't in the Workspace's Packages`)),
      { warnings, missingPackages: [...new Set(missing.map(({ specifier }) => specifier))] },
    );
  }
  const main = modules[mainModule];
  const exported = new Set(parse(typeof main === "string" ? main : (main?.js ?? ""))[1].map((name) => ("name" in name ? name.name : "")));
  const unexported = Object.entries(bindings.durableObjects).filter(([, className]) => !exported.has(className));
  if (unexported.length > 0 || bindings.problems.length > 0) {
    return fail(
      unexported.map(([binding, className]) => ({
        message: `${config.main ?? "The Worker"} doesn't export the class "${className}" that ${binding} binds to.`,
        file: "wrangler.jsonc",
        line: null,
        column: null,
      })),
      { warnings },
    );
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
    durableObjects: bindings.durableObjects,
    tailwindCandidates,
    warnings,
  };
}

type WranglerAssets = { not_found_handling?: unknown; run_worker_first?: unknown };

// What `wrangler.jsonc` can ask for that the platform doesn't have: apps get
// Durable Objects and nothing else (ADR 0006).
const unsupported: { key: string; what: string; present(config: Record<string, unknown>): boolean }[] = [
  { key: "kv_namespaces", what: "KV", present: (config) => nonEmpty(config.kv_namespaces) },
  { key: "d1_databases", what: "D1", present: (config) => nonEmpty(config.d1_databases) },
  { key: "r2_buckets", what: "R2", present: (config) => nonEmpty(config.r2_buckets) },
  {
    key: "queues",
    what: "Queues",
    present: (config) => {
      const queues = config.queues as { producers?: unknown; consumers?: unknown } | undefined;
      return nonEmpty(queues?.producers) || nonEmpty(queues?.consumers);
    },
  },
  {
    key: "triggers.crons",
    what: "Cron Triggers",
    present: (config) => nonEmpty((config.triggers as { crons?: unknown } | undefined)?.crons),
  },
];

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

/**
 * The Durable Object bindings `wrangler.jsonc` declares, binding to class,
 * and the problems with what it declares: anything the platform doesn't
 * have, and classes it can't run.
 */
function durableObjectBindings(config: Record<string, unknown>): { durableObjects: Record<string, string>; problems: BuildProblem[] } {
  const place = { file: "wrangler.jsonc", line: null, column: null };
  const problems: BuildProblem[] = unsupported
    .filter(({ present }) => present(config))
    .map(({ key, what }) => ({
      message: `${key} in wrangler.jsonc: ${what} isn't available here. Apps get Durable Objects and nothing else.`,
      ...place,
    }));
  const durableObjects: Record<string, string> = {};
  const declared = (config.durable_objects as { bindings?: unknown } | undefined)?.bindings;
  for (const binding of Array.isArray(declared) ? (declared as Record<string, unknown>[]) : []) {
    const name = String(binding.name ?? "");
    const className = String(binding.class_name ?? "");
    if (typeof binding.script_name === "string" && binding.script_name !== "") {
      problems.push({
        message: `${name}'s class is in another Worker ("${binding.script_name}"). An app's Durable Objects must be its own classes.`,
        ...place,
      });
    } else if (!/^[A-Za-z_$][\w$]*$/.test(name) || !/^[A-Za-z_$][\w$]*$/.test(className)) {
      problems.push({ message: `The Durable Object binding "${name}" needs a name and a class_name, each a JavaScript name.`, ...place });
    } else {
      durableObjects[name] = className;
    }
  }
  return { durableObjects, problems };
}

/** Each file under `public/`, at its path below it. */
function publicAssets(snapshot: Snapshot): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const [path, text] of snapshot) if (path.startsWith("public/")) assets[`/${path.slice("public/".length)}`] = text;
  return assets;
}

/** `assets` from `wrangler.jsonc`, with Cloudflare's defaults. Anything the app host can't do is left at its default. */
function assetSettings(assets: WranglerAssets = {}): AssetSettings {
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
