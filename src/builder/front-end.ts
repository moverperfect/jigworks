import { compile } from "tailwindcss";
import packedTailwind from "../generated/tailwind.txt";
import type { BuildProblem } from "../shared/build-report";
import type { Snapshot } from ".";

// A front end, as Vite reads one: index.html links the scripts and
// stylesheets the Build makes. A stylesheet that imports tailwindcss goes
// through the platform's one Tailwind version, with our own scanner and no
// plugins (ADR 0007). Any other stylesheet is plain CSS, which the bundler
// combines with its @imports.

const tailwind = JSON.parse(packedTailwind) as { version: string; stylesheets: Record<string, string> };

/** The platform's Tailwind version, which goes into every Build's hash. */
export const tailwindVersion = tailwind.version;

/** What index.html asks the Build for. */
export interface Page {
  /** index.html, with its links pointed at what the Build makes. */
  html: string;
  /** Workspace paths of the module scripts it links, such as `src/client/main.tsx`. */
  scripts: string[];
  /** Workspace paths of the stylesheets it links. */
  stylesheets: string[];
  problems: BuildProblem[];
}

/** Where the Build serves what it makes from a file: `src/client/main.tsx` at `/client/main.js`, as the bundler names it. */
export function outputPath(path: string): string {
  return `/${path.replace(/^src\//, "").replace(/\.(tsx?|jsx?)$/, ".js")}`;
}

/** The scripts and stylesheets index.html links, and index.html pointed at their Build output. Files in `public/` are left alone. */
export async function readPage(snapshot: Snapshot): Promise<Page> {
  const source = snapshot.get("index.html") ?? "";
  const scripts: string[] = [];
  const stylesheets: string[] = [];
  const problems: BuildProblem[] = [];
  const link = (element: Element, attribute: string, into: string[]) => {
    const url = element.getAttribute(attribute) ?? "";
    // Another site's file, or a data: URL.
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return;
    const path = decodeURIComponent(url.replace(/[?#].*$/, "")).replace(/^\.?\//, "");
    if (snapshot.has(`public/${path}`)) return;
    if (!snapshot.has(path)) {
      problems.push({ message: `index.html links ${url}, which isn't a Workspace file or in public/`, ...placeOf(source, url, "index.html") });
      return;
    }
    into.push(path);
    element.setAttribute(attribute, outputPath(path));
  };
  const html = await new HTMLRewriter()
    .on('script[type="module"][src]', { element: (element) => link(element, "src", scripts) })
    .on('link[rel="stylesheet"][href]', { element: (element) => link(element, "href", stylesheets) })
    .transform(new Response(source))
    .text();
  return { html, scripts, stylesheets, problems };
}

/** Whether a stylesheet imports Tailwind, itself or through the Workspace's own stylesheets it imports. */
export function usesTailwind(path: string, snapshot: Snapshot, seen = new Set<string>()): boolean {
  if (seen.has(path)) return false;
  seen.add(path);
  const css = withoutComments(snapshot.get(path) ?? "");
  if (/@tailwind\s/.test(css)) return true;
  for (const [, id] of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    if (id === "tailwindcss" || id!.startsWith("tailwindcss/")) return true;
    const own = id!.startsWith(".") || id!.startsWith("/");
    if (own && usesTailwind(join(dirname(path), id!), snapshot, seen)) return true;
  }
  return false;
}

/**
 * Compiles a stylesheet with the platform's Tailwind, for the class names
 * the Workspace's files use. `@plugin` and `@config` fail at the line that
 * has them, because there's nothing to load them with (ADR 0007).
 */
export async function compileTailwind(
  path: string,
  snapshot: Snapshot,
): Promise<{ css: string; candidates: number } | { problems: BuildProblem[]; failure: "unsupported" | "error" }> {
  const unsupported: BuildProblem[] = [];
  const check = (file: string, css: string) => {
    const code = withoutComments(css);
    for (const match of code.matchAll(/@(plugin|config)\b/g)) {
      unsupported.push({
        message: `@${match[1]} isn't supported: the platform's Tailwind runs without plugins or config files.`,
        ...placeAt(code, match.index, file),
      });
    }
  };
  const entry = snapshot.get(path) ?? "";
  check(path, entry);
  try {
    const compiler = await compile(entry, {
      base: dirname(path),
      from: path,
      async loadStylesheet(id, base) {
        const own = tailwindStylesheet(id);
        if (own !== undefined) return { path: id, base, content: own };
        const file = join(base, id);
        const content = snapshot.get(file);
        if (content === undefined) throw new Error(`"${id}" isn't a Workspace file`);
        check(file, content);
        return { path: file, base: dirname(file), content };
      },
      async loadModule(id, _base, kind) {
        throw new Error(`@${kind} "${id}" isn't supported`);
      },
    });
    if (unsupported.length > 0) return { problems: unsupported, failure: "unsupported" };
    const found = candidates(snapshot);
    return { css: compiler.build([...found]), candidates: found.size };
  } catch (error) {
    if (unsupported.length > 0) return { problems: unsupported, failure: "unsupported" };
    const message = error instanceof Error ? error.message : String(error);
    return { problems: [{ message: `Tailwind: ${message}`, file: path, line: null, column: null }], failure: "error" };
  }
}

// The files Tailwind's own scanner would read: markup and code, but not
// stylesheets, Packages or type declarations.
const scanned = /\.(html?|[cm]?[jt]sx?|mdx?|vue|svelte|astro)$/;

/**
 * Everything in the Workspace's files that might be a class name. Tailwind
 * skips the ones it doesn't know, so collecting too much does no harm. A
 * class name pieced together at runtime isn't found.
 */
export function candidates(snapshot: Snapshot): Set<string> {
  const found = new Set<string>();
  for (const [path, text] of snapshot) {
    if (path.startsWith("node_modules/") || /\.d\.[cm]?ts$/.test(path) || !scanned.test(path)) continue;
    for (const token of text.split(/[\s"'`;{}]+/)) {
      if (token.length === 0 || token.length > 200) continue;
      found.add(token);
      // Such as `"p-4",` in an array, or `(p-4)` in a call.
      const trimmed = token.replace(/^[(,]+/, "").replace(/[),.:]+$/, "");
      if (trimmed.length > 0) found.add(trimmed);
    }
    // Arbitrary values with quotes inside, such as `bg-[url('/hero.svg')]`,
    // which splitting on quotes breaks up.
    for (const [bracketed] of text.matchAll(/[^\s"'`;{}<>]*\[[^\s\]]*["'][^\s\]]*\][^\s"'`;{}<>]*/g)) {
      if (bracketed.length <= 200) found.add(bracketed);
    }
  }
  return found;
}

function tailwindStylesheet(id: string): string | undefined {
  if (id === "tailwindcss") return tailwind.stylesheets["index.css"];
  const part = /^tailwindcss\/(index|theme|preflight|utilities)(?:\.css)?$/.exec(id)?.[1];
  return part === undefined ? undefined : tailwind.stylesheets[`${part}.css`];
}

/** CSS with its comments blanked out, keeping every line where it was. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function placeAt(text: string, index: number, file: string): Pick<BuildProblem, "file" | "line" | "column"> {
  const before = text.slice(0, index);
  return { file, line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

function placeOf(text: string, found: string, file: string): Pick<BuildProblem, "file" | "line" | "column"> {
  const index = text.indexOf(found);
  return index < 0 ? { file, line: null, column: null } : placeAt(text, index, file);
}

function dirname(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** `id` resolved from the folder `base`, both relative to the Workspace's root. */
function join(base: string, id: string): string {
  const parts = id.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const part of id.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
