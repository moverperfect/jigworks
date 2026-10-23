import { maxFileBytes as defaultMaxFileBytes } from "../files";

/** A Package's files, as its tarball holds them. */
export interface DownloadedPackage {
  /** Path relative to the Package root (the tarball's first folder stripped), to UTF-8 text. */
  files: Map<string, string>;
  /** Files of a kept type that were left out anyway, and why. Dropped file types aren't listed. */
  skipped: { path: string; reason: "too-large" | "not-text" }[];
}

// The file types the Checker and the Builder read. Everything else in a
// tarball, including `.ts` sources that aren't declarations, is dropped.
const keptSuffixes = [".js", ".mjs", ".cjs", ".json", ".d.ts", ".d.mts", ".d.cts", ".css"];

// Limits that keep one tarball from exhausting the isolate's 128 MB, whether
// it's simply huge or a compression bomb.
const maxTarballBytes = 32 * 1024 * 1024;
const maxUnpackedBytes = 64 * 1024 * 1024;
const downloadTimeoutMs = 60_000;

/**
 * Downloads a Package's tarball, checks it against the registry's integrity
 * value, and returns the files of the kept types.
 */
export async function downloadPackage(
  tarballUrl: string,
  integrity: { integrity?: string; shasum?: string },
  options: { fetch?: typeof fetch; maxFileBytes?: number } = {},
): Promise<DownloadedPackage> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(tarballUrl, { signal: AbortSignal.timeout(downloadTimeoutMs) });
  if (!response.ok || !response.body) {
    // An unread body holds its connection open.
    await response.body?.cancel();
    throw new Error(`Couldn't download ${tarballUrl}: HTTP ${response.status}`);
  }
  const tarball = await readAll(response.body, maxTarballBytes, tarballUrl);
  await checkIntegrity(tarballUrl, tarball, integrity);
  const tar = await readAll(new Blob([tarball]).stream().pipeThrough(new DecompressionStream("gzip")), maxUnpackedBytes, tarballUrl);
  return keptFiles(tar, options.maxFileBytes ?? defaultMaxFileBytes);
}

/** Reads a stream into memory, giving up once it passes `limit` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, limit: number, url: string): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`${url} is larger than the platform installs (${Math.round(limit / 1024 / 1024)} MB)`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// SRI algorithms, strongest first, with Web Crypto's names for them. npm's
// oldest tarballs have only sha1.
const sriAlgorithms = [
  ["sha512", "SHA-512"],
  ["sha384", "SHA-384"],
  ["sha256", "SHA-256"],
  ["sha1", "SHA-1"],
] as const;

/**
 * Throws unless the tarball matches the strongest hash in the SRI string, or
 * the sha1 `shasum` when the SRI string has no hash we know. A tarball with
 * neither is refused: npm always sends at least a shasum.
 */
async function checkIntegrity(
  url: string,
  tarball: Uint8Array<ArrayBuffer>,
  { integrity = "", shasum }: { integrity?: string; shasum?: string },
): Promise<void> {
  const hashes = integrity.trim().split(/\s+/);
  for (const [prefix, algorithm] of sriAlgorithms) {
    const expected = hashes.filter((hash) => hash.startsWith(`${prefix}-`)).map((hash) => hash.slice(prefix.length + 1));
    if (expected.length === 0) continue;
    // SRI passes when any hash of the strongest algorithm matches.
    if (expected.includes(base64(await digest(algorithm, tarball)))) return;
    throw new Error(`${url} doesn't match its ${prefix} integrity value`);
  }
  if (!shasum) throw new Error(`${url} has no integrity value to check it against`);
  if (hex(await digest("SHA-1", tarball)) !== shasum.toLowerCase()) {
    throw new Error(`${url} doesn't match its sha1 shasum`);
  }
}

async function digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, data));
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The kept-type files in a tar archive, below the package root. */
function keptFiles(tar: Uint8Array, maxFileBytes: number): DownloadedPackage {
  const files = new Map<string, string>();
  const skipped: DownloadedPackage["skipped"] = [];
  for (const entry of tarFiles(tar)) {
    const path = packagePath(entry.path);
    if (!path || !keptSuffixes.some((suffix) => path.endsWith(suffix))) continue;
    if (entry.data.length > maxFileBytes) {
      skipped.push({ path, reason: "too-large" });
      continue;
    }
    try {
      files.set(path, strictUtf8.decode(entry.data));
    } catch {
      skipped.push({ path, reason: "not-text" });
    }
  }
  return { files, skipped };
}

/**
 * An entry's path below the package root. Like npm, strips the first segment
 * whatever it's called: usually `package/`, but not always. Null for a path
 * that is absolute after that, climbs out with `..`, or is the root itself.
 */
function packagePath(entryPath: string): string | null {
  const rest = entryPath.replace(/\\/g, "/").split("/").slice(1).join("/");
  if (rest.startsWith("/") || /^[a-z]:/i.test(rest)) return null;
  const parts = rest.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

const blockSize = 512;
const headerText = new TextDecoder();

/**
 * The regular files in an uncompressed tar archive, with their full paths.
 * Reads ustar headers, GNU long names and PAX paths. Skips directories, links
 * and every other kind of entry, and stops at the end-of-archive blocks or at
 * an entry cut short.
 */
function* tarFiles(tar: Uint8Array): Generator<{ path: string; data: Uint8Array }> {
  // A path from a GNU `L` or PAX `x` header, for the entry that follows it.
  let longPath: string | undefined;
  let offset = 0;
  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (isZero(header)) {
      // Two zero blocks end the archive.
      const next = tar.subarray(offset + blockSize, offset + 2 * blockSize);
      if (next.length < blockSize || isZero(next)) return;
      offset += blockSize;
      continue;
    }
    const start = offset + blockSize;
    const size = sizeOf(header.subarray(124, 136));
    if (start + size > tar.length) return;
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / blockSize) * blockSize;

    const type = String.fromCharCode(header[156]!);
    if (type === "L") longPath = cString(data);
    else if (type === "x") longPath = paxPath(data) ?? longPath;
    else {
      // Everything else, including PAX `g` global headers, uses up the long path.
      const path = longPath ?? ustarPath(header);
      longPath = undefined;
      if (type === "0" || type === "\0") yield { path, data };
    }
  }
}

/** The name field, after the prefix field when the header is POSIX ustar. GNU headers keep other things there. */
function ustarPath(header: Uint8Array): string {
  const name = cString(header.subarray(0, 100));
  const prefix = cString(header.subarray(257, 263)) === "ustar" ? cString(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

/** A size field: octal text, or a base-256 number when its first byte's high bit is set. */
function sizeOf(field: Uint8Array): number {
  if (field[0]! & 0x80) return field.subarray(1).reduce((size, byte) => size * 256 + byte, field[0]! & 0x7f);
  return Number.parseInt(cString(field), 8) || 0;
}

/** The `path` record of a PAX extended header, whose records read `<bytes> <key>=<value>\n`. */
function paxPath(data: Uint8Array): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(headerText.decode(data.subarray(offset, space)), 10);
    if (!(length > space - offset) || offset + length > data.length) break;
    const record = headerText.decode(data.subarray(space + 1, offset + length - 1));
    if (record.startsWith("path=")) path = record.slice("path=".length);
    offset += length;
  }
  return path;
}

/** Text up to the first NUL. */
function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return headerText.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
