import { gzipSync } from "fflate";
import { prerelease, rsort } from "semver";

/** One published version of a FakePackage. */
export interface FakeVersion {
  /** How long ago this version was published. */
  ageHours: number;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  /** Leaves this version out of the full document's publish times, as a stale cached copy would. */
  omitPublishTime?: boolean;
  /** Files relative to the package root. A package.json is generated unless one is given. */
  files: Record<string, string | Uint8Array>;
}

/** A Package as the fake registry publishes it. */
export interface FakePackage {
  name: string;
  versions: Record<string, FakeVersion>;
  /** Defaults to `{ latest: <highest version that isn't a prerelease> }`. */
  distTags?: Record<string, string>;
}

interface Tarball {
  bytes: Uint8Array;
  integrity: string;
  shasum: string;
}

const compactType = "application/vnd.npm.install-v1+json";
const hour = 3_600_000;
const encoder = new TextEncoder();

// The fields of a version's entry in the registry's documents, in npm's order,
// which a generated package.json repeats.
const entryFields = ["dependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies", "os", "cpu"] as const;
const packageJsonFields = entryFields;

/**
 * An npm registry answering from `packages`, for vitest's `outboundService`.
 * It serves both document formats and the tarballs they point to, and answers
 * null for any other origin so the config can try its next handler. Publish
 * times are reckoned from `now` on each request; everything else is the same
 * bytes every time.
 */
export function fakeRegistry(
  packages: FakePackage[],
  { registry = "https://registry.npmjs.org", now = Date.now }: { registry?: string; now?: () => number } = {},
): (request: Request) => Promise<Response | null> {
  const root = registry.replace(/\/+$/, "");
  const base = new URL(root);
  const prefix = base.pathname.replace(/\/+$/, "");
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const tarballs = new Map<string, Promise<Tarball>>();

  const tarballUrl = (name: string, version: string) => `${root}/${name}/-/${basename(name)}-${version}.tgz`;

  function tarball(pkg: FakePackage, version: string): Promise<Tarball> {
    const key = `${pkg.name}@${version}`;
    let built = tarballs.get(key);
    if (!built) {
      built = pack(pkg.name, version, pkg.versions[version]!);
      tarballs.set(key, built);
    }
    return built;
  }

  async function document(pkg: FakePackage, compact: boolean, at: number): Promise<object> {
    const versions = Object.keys(pkg.versions);
    const entries = await Promise.all(
      versions.map(async (version) => {
        const { integrity, shasum } = await tarball(pkg, version);
        return {
          name: pkg.name,
          version,
          ...pick(pkg.versions[version]!, entryFields),
          dist: { tarball: tarballUrl(pkg.name, version), integrity, shasum },
        };
      }),
    );
    const published = (hours: number) => new Date(at - hours * hour).toISOString();
    const ages = versions.map((version) => pkg.versions[version]!.ageHours);
    const modified = published(ages.length ? Math.min(...ages) : 0);
    const distTags = pkg.distTags ?? defaultTags(versions);

    if (compact) {
      return {
        name: pkg.name,
        "dist-tags": distTags,
        versions: Object.fromEntries(entries.map((entry) => [entry.version, entry])),
        modified,
      };
    }
    return {
      _id: pkg.name,
      name: pkg.name,
      "dist-tags": distTags,
      versions: Object.fromEntries(
        entries.map((entry) => [
          entry.version,
          { ...entry, _id: `${pkg.name}@${entry.version}`, description: "", readme: "" },
        ]),
      ),
      time: {
        created: published(ages.length ? Math.max(...ages) : 0),
        modified,
        ...Object.fromEntries(
          versions
            .map((version, i) => [version, published(ages[i]!)] as const)
            .filter(([version]) => !pkg.versions[version]!.omitPublishTime),
        ),
      },
      readme: "",
    };
  }

  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== base.origin) return null;
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    if (!url.pathname.startsWith(`${prefix}/`)) return notFound();

    // Decoding lets a scoped name arrive as `@scope%2Fname` or `@scope/name`.
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    } catch {
      return notFound();
    }

    const pkg = byName.get(path);
    if (pkg) {
      const compact = request.headers.get("accept")?.includes(compactType) ?? false;
      return json(await document(pkg, compact, now()), compact ? compactType : "application/json");
    }

    // <name>/-/<basename>-<version>.tgz
    const match = /^(.+)\/-\/([^/]+)\.tgz$/.exec(path);
    const owner = match ? byName.get(match[1]!) : undefined;
    if (match && owner) {
      const start = `${basename(owner.name)}-`;
      const version = match[2]!.startsWith(start) ? match[2]!.slice(start.length) : "";
      if (Object.hasOwn(owner.versions, version)) {
        const { bytes } = await tarball(owner, version);
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      }
    }
    return notFound();
  };
}

/** `{ latest }` at the highest release, or the highest prerelease when there are only prereleases. */
function defaultTags(versions: string[]): Record<string, string> {
  const sorted = rsort([...versions]);
  const latest = sorted.find((version) => !prerelease(version)) ?? sorted[0];
  return latest === undefined ? {} : { latest };
}

/** A version's .tgz, laid out as `npm pack` does, with every file under `package/`. */
async function pack(name: string, version: string, fake: FakeVersion): Promise<Tarball> {
  const manifest = { name, version, ...pick(fake, packageJsonFields) };
  const files = { "package.json": `${JSON.stringify(manifest, null, 2)}\n`, ...fake.files };
  const bytes = gzipSync(tar(Object.entries(files).map(([path, content]) => [`package/${path}`, content])), {
    mtime: 0,
  });
  const [sha512, sha1] = await Promise.all([digest("SHA-512", bytes), digest("SHA-1", bytes)]);
  return {
    bytes,
    integrity: `sha512-${btoa(String.fromCharCode(...sha512))}`,
    shasum: [...sha1].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** A ustar archive of regular files, each with mode 0644 and mtime 0. */
function tar(files: [string, string | Uint8Array][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, content] of files) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const name = encoder.encode(path);
    // The name field holds 100 bytes; a PAX header carries a longer path.
    if (name.length > 100) {
      const record = paxRecord("path", path);
      blocks.push(header(encoder.encode("././@PaxHeader"), record.length, "x"), padded(record));
    }
    blocks.push(header(name.subarray(0, 100), data.length, "0"), padded(data));
  }
  blocks.push(new Uint8Array(1024));

  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

function header(name: Uint8Array, size: number, type: "0" | "x"): Uint8Array {
  const block = new Uint8Array(512);
  const field = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  block.set(name, 0);
  field(100, "0000644\0");
  field(108, "0000000\0");
  field(116, "0000000\0");
  field(124, `${size.toString(8).padStart(11, "0")}\0`);
  field(136, "00000000000\0");
  field(148, " ".repeat(8));
  field(156, type);
  field(257, "ustar\0");
  field(263, "00");
  // The checksum counts its own field as spaces.
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  field(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** `<length> <key>=<value>\n`, where the length counts its own digits. */
function paxRecord(key: string, value: string): Uint8Array {
  const rest = encoder.encode(` ${key}=${value}\n`).length;
  let length = rest;
  while (length !== rest + String(length).length) length = rest + String(length).length;
  return encoder.encode(`${length} ${key}=${value}\n`);
}

function padded(data: Uint8Array): Uint8Array {
  const block = new Uint8Array(Math.ceil(data.length / 512) * 512);
  block.set(data);
  return block;
}

function pick<K extends keyof FakeVersion>(fake: FakeVersion, fields: readonly K[]): Partial<Pick<FakeVersion, K>> {
  return Object.fromEntries(
    fields.filter((field) => fake[field] !== undefined).map((field) => [field, fake[field]]),
  ) as Partial<Pick<FakeVersion, K>>;
}

async function digest(algorithm: string, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

function basename(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

function json(body: unknown, type: string, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
}

function notFound(): Response {
  return json({ error: "Not found" }, "application/json", 404);
}
