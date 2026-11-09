// What a Build and the tests' bundle share: the files the bundler is given,
// and how its output and errors are read.
import { parse } from "es-module-lexer/js";
import { fromBase64, toBase64 } from "../shared/base64";
import type { BuildProblem } from "../shared/build-report";

/** A Workspace's text files and Packages: path relative to the Workspace root, to text. */
export type Snapshot = ReadonlyMap<string, string>;

/** A file's text, or its bytes if it isn't UTF-8 text, as an image or a font isn't (#110). */
export type FileContent = string | Uint8Array;

/**
 * A Workspace's files and Packages, read one at a time. A large app's
 * Packages ran to 46.6 MB of text, and holding them all at once put the
 * Workspace's Durable Object over its memory limit before esbuild started
 * (#87, docs/findings.md).
 */
export interface FileSource<Content extends FileContent = FileContent> {
  /** Every path, once each. */
  paths(): string[];
  read(path: string): Content | undefined;
}

export const filesOf = (files: ReadonlyMap<string, FileContent>): FileSource => ({ paths: () => [...files.keys()], read: (path) => files.get(path) });

/** Only the text files, which is all the bundler and the front end's steps read. */
export const textFiles = (files: ReadonlyMap<string, FileContent>): Snapshot =>
  new Map([...files].filter((file): file is [string, string] => typeof file[1] === "string"));

/** Package files a bundle never takes in: type declarations, source maps and Markdown. */
export const notBundled = /^node_modules\/.*(\.d\.[cm]?ts|\.map|\.md)$/;

// About a megabyte a chunk, so the sender holds no more than that at once.
const chunkChars = 1 << 20;

/**
 * The files a bundle takes in, one `[path, text]` JSON line each, or
 * `[path, base64, "base64"]` for a file's bytes, read only as the stream is.
 * A stream isn't held to an RPC call's 32 MiB.
 */
export function bundledStream(files: FileSource): ReadableStream<Uint8Array> {
  const paths = files.paths().filter((path) => !notBundled.test(path));
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      const lines: string[] = [];
      for (let size = 0; next < paths.length && size < chunkChars; ) {
        const path = paths[next++]!;
        const content = files.read(path);
        if (content === undefined) continue;
        const line = `${JSON.stringify(typeof content === "string" ? [path, content] : [path, toBase64(content), "base64"])}\n`;
        lines.push(line);
        size += line.length;
      }
      // A file larger than a chunk still goes in chunks.
      const bytes = encoder.encode(lines.join(""));
      for (let at = 0; at < bytes.length; at += chunkChars) controller.enqueue(bytes.slice(at, at + chunkChars));
      if (next >= paths.length) controller.close();
    },
  });
}

/** The files a `bundledStream` carries, text and bytes. */
export async function snapshotFrom(stream: ReadableStream<Uint8Array>): Promise<Map<string, FileContent>> {
  const snapshot = new Map<string, FileContent>();
  // A file's line can span many chunks, so its pieces wait here until its end.
  let pieces: string[] = [];
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      pieces.push(chunk.slice(start, end));
      const [path, content, encoding] = JSON.parse(pieces.join("")) as [string, string, "base64"?];
      snapshot.set(path, encoding === "base64" ? fromBase64(content) : content);
      pieces = [];
      start = end + 1;
    }
    if (start < chunk.length) pieces.push(chunk.slice(start));
  }
  return snapshot;
}

/** Changes when the same files bundle differently, so a Build's hash does too. 2: no `node` conditions. */
export const bundlingVersion = 2;

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
