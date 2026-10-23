import { rsort, satisfies, valid, validRange } from "semver";
import type { PackageDocument, Registry, VersionManifest } from "./registry";

/** The fields of a Workspace's package.json that list its Packages. */
export interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export const manifestFields = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** The versions an install chose, one per Package, and what didn't fit. */
export interface Resolution {
  versions: Map<string, VersionManifest>;
  warnings: string[];
}

interface Requirement {
  name: string;
  range: string;
  /** "package.json", or the `name@version` that asked. */
  from: string;
  optional: boolean;
}

/** Versions published closer to now than this are refused, directly or indirectly. */
export const minimumPackageAgeMs = 24 * 60 * 60 * 1000;

const maxRounds = 20;
const label = (version: VersionManifest) => `${version.name}@${version.version}`;

/**
 * Chooses one version of every Package a manifest needs, the flat layout the
 * Builder needs. A version listed in the manifest wins. Otherwise the newest
 * version that every requester accepts is used, or, failing that, the one the
 * first requester accepts, with a warning. Peers are installed like any other
 * requirement, and those that don't fit are warnings too. Versions published
 * less than a day ago are never chosen. Packages that only run on a
 * particular operating system or CPU are skipped.
 */
export async function resolve(manifest: Manifest, registry: Registry, now = Date.now()): Promise<Resolution> {
  // Each round's warnings replace the last round's, so only the final choices' remain.
  let warnings = new Set<string>();
  const direct = new Map<string, Requirement>();
  for (const field of [...manifestFields].reverse()) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      direct.set(name, { name, range, from: "package.json", optional: field === "optionalDependencies" });
    }
  }

  const choose = async (name: string, requirements: Requirement[]): Promise<VersionManifest | null> => {
    const document = await registry.document(name);
    const required = !requirements.every((r) => r.optional);
    if (!document) {
      if (required) warnings.add(`${name} isn't in the npm registry.`);
      return null;
    }
    const readable = requirements.filter((r) => {
      const ok = isReadable(document, r.range);
      if (!ok) warnings.add(`${r.from} asks for ${name}@${r.range}, a kind of version the platform can't install.`);
      return ok;
    });
    if (readable.length === 0) return null;
    const candidates = await oldEnough(document, registry, now);
    const newest = (ranges: string[]) => candidates.find((v) => ranges.every((range) => accepts(document, v, range)));
    const version = newest(readable.map((r) => r.range)) ?? newest([readable[0]!.range]);
    if (!version) {
      if (required) warnings.add(noVersionMessage(document, readable[0]!.range));
      return null;
    }
    return document.versions.get(version)!;
  };

  // Each round walks the graph from the manifest using the versions chosen so
  // far, collects every requirement, and chooses again, until nothing changes.
  let chosen = new Map<string, VersionManifest>();
  let requirements = new Map<string, Requirement[]>();
  let settled = false;
  for (let round = 0; round < maxRounds && !settled; round++) {
    warnings = new Set();
    requirements = new Map();
    const walked = new Map<string, VersionManifest>();
    const queue = [...direct.values()];
    while (queue.length > 0) {
      const requirement = queue.shift()!;
      const list = requirements.get(requirement.name) ?? [];
      if (list.length === 0) requirements.set(requirement.name, list);
      list.push(requirement);
      if (list.length > 1) continue;

      const version = chosen.get(requirement.name) ?? (await choose(requirement.name, [requirement]));
      if (!version || isPlatformSpecific(version)) continue;
      walked.set(requirement.name, version);
      const from = label(version);
      for (const [name, range] of Object.entries(version.dependencies ?? {})) queue.push({ name, range, from, optional: false });
      for (const [name, range] of Object.entries(version.optionalDependencies ?? {})) queue.push({ name, range, from, optional: true });
      for (const [name, range] of Object.entries(version.peerDependencies ?? {})) {
        if (!version.peerDependenciesMeta?.[name]?.optional) queue.push({ name, range, from, optional: false });
      }
    }

    const next = new Map<string, VersionManifest>();
    for (const [name, list] of requirements) {
      const own = direct.get(name);
      const version = await choose(name, own ? [own] : list);
      if (version && !isPlatformSpecific(version)) next.set(name, version);
      else if (version && !list.every((r) => r.optional)) {
        warnings.add(`${label(version)} only runs on particular systems, so it isn't installed.`);
      }
    }
    settled = next.size === walked.size && [...next].every(([name, v]) => walked.get(name)?.version === v.version);
    chosen = next;
  }
  if (!settled) warnings.add(`The Packages' versions didn't settle after ${maxRounds} rounds, so some may not fit together.`);

  for (const [name, list] of requirements) {
    const version = chosen.get(name);
    const document = version && (await registry.document(name));
    if (!version || !document) continue;
    const unmet = list.filter((r) => isReadable(document, r.range) && !accepts(document, version.version, r.range));
    if (unmet.length > 0) {
      warnings.add(`${label(version)} is installed, but ${unmet.map((r) => `${r.from} wants ${r.range}`).join(", ")}.`);
    }
  }
  for (const version of chosen.values()) {
    for (const [name, range] of Object.entries(version.peerDependencies ?? {})) {
      const peer = chosen.get(name);
      const document = peer && version.peerDependenciesMeta?.[name]?.optional && (await registry.document(name));
      if (peer && document && isReadable(document, range) && !accepts(document, peer.version, range)) {
        warnings.add(`${label(peer)} is installed, but ${label(version)} wants ${range}.`);
      }
    }
  }

  return { versions: chosen, warnings: [...warnings] };
}

/**
 * The newest version of a Package that's at least a day old and matches
 * `range` (any version when it's empty), for adding a Package by name.
 * Prereleases only match a range that names one.
 */
export async function newestVersion(document: PackageDocument, range: string, registry: Registry, now = Date.now()) {
  const candidates = await oldEnough(document, registry, now);
  return candidates.find((version) => accepts(document, version, range || "*")) ?? null;
}

/** Why no version could be chosen: none matches at all, or none that matches is a day old. */
export function noVersionMessage(document: PackageDocument, range: string): string {
  const matching = [...document.versions.keys()].some((v) => valid(v) && accepts(document, v, range || "*"));
  if (!matching) return `No version of ${document.name} matches ${range}.`;
  return `No version of ${document.name}${range ? ` matching ${range}` : ""} is at least a day old.`;
}

/**
 * Versions, newest first, published at least a day before `now`. A version
 * whose publish time the registry doesn't give counts as too new.
 */
async function oldEnough(document: PackageDocument, registry: Registry, now: number): Promise<string[]> {
  const all = rsort([...document.versions.keys()].filter((version) => valid(version)));
  const cutoff = now - minimumPackageAgeMs;
  // A document untouched for a day has nothing newer than a day in it, so its
  // publish times aren't needed.
  if (Date.parse(document.modified) <= cutoff) return all;
  const times = await registry.publishTimes(document.name);
  return all.filter((version) => Date.parse(times[version] ?? "") <= cutoff);
}

function accepts(document: PackageDocument, version: string, range: string): boolean {
  const tagged = document.distTags[range];
  if (tagged) return version === tagged;
  return satisfies(version, range);
}

/** A semver range or one of the Package's tags. Not git URLs, tarball URLs, `file:` or `npm:` aliases. */
function isReadable(document: PackageDocument, range: string): boolean {
  return validRange(range) !== null || range in document.distTags;
}

/** A Package that names the systems it runs on. Lists that only exclude systems, such as `!win32`, don't count. */
function isPlatformSpecific(version: VersionManifest): boolean {
  const names = (list?: string[]) => (list ?? []).some((entry) => !entry.startsWith("!"));
  return names(version.os) || names(version.cpu);
}
