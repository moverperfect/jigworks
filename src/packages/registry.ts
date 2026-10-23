import { readPublishTimes } from "./publish-times";

/** One version of a Package, as the registry's compact document describes it. */
export interface VersionManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  dist: { tarball: string; integrity?: string; shasum?: string };
}

/** A Package's versions and tags, from the registry's compact document. */
export interface PackageDocument {
  name: string;
  distTags: Record<string, string>;
  versions: Map<string, VersionManifest>;
  /** When the registry last changed the document. */
  modified: string;
}

/** The parts of the npm registry an install reads. */
export interface Registry {
  /** The Package's compact document, or null if the registry doesn't have it. */
  document(name: string): Promise<PackageDocument | null>;
  /** Each version's publish time. Costs a download of the full document. */
  publishTimes(name: string): Promise<Record<string, string>>;
}

const registryUrl = "https://registry.npmjs.org";
const timeoutMs = 30_000;

/**
 * The npm registry, read with the compact document format. The full format is
 * the only one with publish times, and can be tens of megabytes, so
 * `publishTimes` streams it and keeps only the times. Each document is
 * fetched once per client, so one client should serve one install.
 */
export function registryClient(): Registry {
  const documents = new Map<string, Promise<PackageDocument | null>>();
  const times = new Map<string, Promise<Record<string, string>>>();
  const get = (name: string, accept: string) =>
    fetch(`${registryUrl}/${name.replace("/", "%2F")}`, {
      headers: { accept },
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    document: (name) =>
      once(documents, name, async () => {
        const response = await get(name, "application/vnd.npm.install-v1+json");
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) throw new Error(`The npm registry answered ${response.status} for ${name}`);
        const body = (await response.json()) as {
          name: string;
          "dist-tags"?: Record<string, string>;
          versions?: Record<string, VersionManifest>;
          modified?: string;
        };
        return {
          name: body.name,
          distTags: body["dist-tags"] ?? {},
          versions: new Map(Object.entries(body.versions ?? {})),
          // Without a date, assume it just changed, so publish times get checked.
          modified: body.modified ?? new Date().toISOString(),
        };
      }),

    publishTimes: (name) =>
      once(times, name, async () => {
        const response = await get(name, "application/json");
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`The npm registry answered ${response.status} for ${name}'s publish times`);
        }
        return readPublishTimes(response.body);
      }),
  };
}

function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (!value) {
    value = load();
    cache.set(key, value);
  }
  return value;
}
