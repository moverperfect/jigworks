import { describe, expect, it } from "vitest";
import { downloadPackage } from "../src/packages/tarball";

const url = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
const encoder = new TextEncoder();

const typeflags = {
  file: "0",
  "old-file": "\0",
  "hard-link": "1",
  symlink: "2",
  directory: "5",
  "pax-global": "g",
};

/** One tar entry, as `npm pack` or another tool might write it. */
interface Entry {
  path: string;
  type?: keyof typeof typeflags;
  content?: string | Uint8Array;
  /** Where a path too long for the name field goes: a PAX header, a GNU `L` header, or ustar's prefix field. */
  long?: "pax" | "gnu" | "prefix";
  /** Writes the size field in base-256, as tar does for files over 8 GB. */
  base256Size?: boolean;
}

/** A gzipped tar archive of the entries. */
async function tgz(entries: Entry[]): Promise<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  const add = (fields: HeaderFields, data: Uint8Array) =>
    blocks.push(header({ ...fields, size: data.length }), data, new Uint8Array((512 - (data.length % 512)) % 512));

  for (const { path, type = "file", content = "", long, base256Size } of entries) {
    let name = path;
    let prefix = "";
    if (long === "pax") {
      add({ name: "PaxHeader", type: "x" }, encoder.encode(paxRecord("mtime", "1700000000.5") + paxRecord("path", path)));
      name = path.slice(0, 100);
    } else if (long === "gnu") {
      add({ name: "././@LongLink", type: "L" }, encoder.encode(`${path}\0`));
      name = path.slice(0, 100);
    } else if (long === "prefix") {
      const cut = path.indexOf("/", path.length - 101);
      [prefix, name] = [path.slice(0, cut), path.slice(cut + 1)];
    }
    const data = typeof content === "string" ? encoder.encode(content) : content;
    add({ name, prefix, type: typeflags[type], base256Size }, data);
  }
  blocks.push(new Uint8Array(1024));
  const stream = new Blob(blocks).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

interface HeaderFields {
  name: string;
  type: string;
  prefix?: string;
  base256Size?: boolean;
}

/** A ustar header block. */
function header({ name, type, prefix = "", base256Size, size }: HeaderFields & { size: number }): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, length: number, value: string) =>
    block.set(encoder.encode(value).subarray(0, length), offset);
  put(0, 100, name);
  put(100, 8, "0000644\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  if (base256Size) {
    block.fill(0, 124, 136);
    block[124] = 0x80;
    for (let i = 135, rest = size; rest > 0; i--, rest = Math.floor(rest / 256)) block[i] = rest % 256;
  }
  put(136, 12, "00000000000\0");
  put(148, 8, "        ");
  put(156, 1, type);
  put(257, 8, "ustar\u000000");
  put(345, 155, prefix);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** A PAX record, whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = encoder.encode(body).length;
  for (let digits = 1; ; digits++) {
    if (String(bodyBytes + digits).length === digits) return `${bodyBytes + digits}${body}`;
  }
}

/** A fetch that serves the tarball at `url` and 404s anything else. */
function serving(tarball: ArrayBuffer): typeof fetch {
  return async (input) => (String(input) === url ? new Response(tarball) : new Response("Not found", { status: 404 }));
}

/** Downloads the entries as a tarball, with its real sha512 integrity value unless the test gives one. */
async function download(
  entries: Entry[],
  { integrity, maxFileBytes }: { integrity?: { integrity?: string; shasum?: string }; maxFileBytes?: number } = {},
) {
  const tarball = await tgz(entries);
  const sri = integrity ?? { integrity: `sha512-${base64(await hash("SHA-512", tarball))}` };
  return downloadPackage(url, sri, { fetch: serving(tarball), maxFileBytes });
}

async function hash(algorithm: string, data: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, data));
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("downloadPackage", () => {
  it("keeps only the kept file types, below the package/ root", async () => {
    const { files, skipped } = await download([
      { path: "package/package.json", content: '{ "name": "example" }' },
      { path: "package/index.js", content: "export const café = 1;\n" },
      { path: "package/index.mjs" },
      { path: "package/index.cjs" },
      { path: "package/index.d.ts" },
      { path: "package/index.d.mts" },
      { path: "package/index.d.cts" },
      { path: "package/dist/style.css" },
      { path: "package/src/index.ts" },
      { path: "package/index.js.map" },
      { path: "package/README.md" },
      { path: "package/logo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]) },
    ]);
    expect([...files.keys()].sort()).toEqual([
      "dist/style.css",
      "index.cjs",
      "index.d.cts",
      "index.d.mts",
      "index.d.ts",
      "index.js",
      "index.mjs",
      "package.json",
    ]);
    expect(files.get("index.js")).toBe("export const café = 1;\n");
    expect(files.get("package.json")).toBe('{ "name": "example" }');
    expect(skipped).toEqual([]);
  });

  it("strips a root folder with another name, and normalises paths", async () => {
    const { files } = await download([
      { path: "react v18.3/package.json" },
      { path: "react v18.3/./index.d.ts" },
      { path: "react v18.3\\ts5.0\\index.d.ts" },
      { path: "react v18.3/lib//jsx.d.ts" },
    ]);
    expect([...files.keys()].sort()).toEqual(["index.d.ts", "lib/jsx.d.ts", "package.json", "ts5.0/index.d.ts"]);
  });

  it("reads a long path from a PAX header, and ignores PAX global headers", async () => {
    const path = `package/${"très-long/".repeat(15)}index.js`;
    const { files } = await download([
      { path: "pax_global_header", type: "pax-global", content: paxRecord("path", "package/global.js") },
      { path, long: "pax", content: "long" },
      { path: "package/after.js", content: "after" },
    ]);
    expect(Object.fromEntries(files)).toEqual({ [path.slice("package/".length)]: "long", "after.js": "after" });
  });

  it("reads a GNU long name", async () => {
    const path = `package/${"nested/".repeat(20)}index.js`;
    const { files } = await download([
      { path, long: "gnu", content: "long" },
      { path: "package/after.js", content: "after" },
    ]);
    expect(Object.fromEntries(files)).toEqual({ [path.slice("package/".length)]: "long", "after.js": "after" });
  });

  it("reads a path split across ustar's prefix and name fields", async () => {
    const path = `package/${"nested/".repeat(20)}index.js`;
    const { files } = await download([{ path, long: "prefix", content: "long" }]);
    expect(Object.fromEntries(files)).toEqual({ [path.slice("package/".length)]: "long" });
  });

  it("reads base-256 sizes", async () => {
    const { files } = await download([{ path: "package/index.js", content: "x".repeat(600), base256Size: true }]);
    expect(files.get("index.js")).toBe("x".repeat(600));
  });

  it("keeps regular files of either typeflag, and skips directories and links", async () => {
    const { files, skipped } = await download([
      { path: "package/lib.js/", type: "directory" },
      { path: "package/linked.js", type: "symlink" },
      { path: "package/hard.js", type: "hard-link" },
      { path: "package/index.js", type: "file" },
      { path: "package/old.js", type: "old-file" },
    ]);
    expect([...files.keys()].sort()).toEqual(["index.js", "old.js"]);
    expect(skipped).toEqual([]);
  });

  it("skips paths that climb out of the package or are absolute", async () => {
    const { files } = await download([
      { path: "package/../escape.js" },
      { path: "package/lib/../../escape.js" },
      { path: "package//absolute.js" },
      { path: "package/C:/drive.js" },
      { path: "package" },
      { path: "package/index.js" },
    ]);
    expect([...files.keys()]).toEqual(["index.js"]);
  });

  it("skips kept-type files over the size limit, but not dropped types", async () => {
    const entries = [
      { path: "package/huge.js", content: "x".repeat(1_900_001) },
      { path: "package/limit.js", content: "x".repeat(1_900_000) },
      { path: "package/HUGE.md", content: "x".repeat(1_900_001) },
    ];
    const byDefault = await download(entries);
    expect([...byDefault.files.keys()]).toEqual(["limit.js"]);
    expect(byDefault.skipped).toEqual([{ path: "huge.js", reason: "too-large" }]);

    const smaller = await download(entries, { maxFileBytes: 10 });
    expect(smaller.files.size).toBe(0);
    expect(smaller.skipped.map(({ path }) => path)).toEqual(["huge.js", "limit.js"]);
  });

  it("skips kept-type files that aren't valid UTF-8", async () => {
    const { files, skipped } = await download([
      { path: "package/binary.js", content: new Uint8Array([0x63, 0xc3, 0x28]) },
      { path: "package/index.js", content: "ok" },
    ]);
    expect(Object.fromEntries(files)).toEqual({ "index.js": "ok" });
    expect(skipped).toEqual([{ path: "binary.js", reason: "not-text" }]);
  });

  describe("integrity", () => {
    const entries = [{ path: "package/index.js", content: "ok" }];
    const fetchOf = (tarball: ArrayBuffer) => ({ fetch: serving(tarball) });

    it("checks the strongest SRI hash, and only that one", async () => {
      const tarball = await tgz(entries);
      const sha512 = `sha512-${base64(await hash("SHA-512", tarball))}`;
      const sha1 = `sha1-${base64(await hash("SHA-1", tarball))}`;
      const wrongSha512 = `sha512-${base64(new Uint8Array(64))}`;
      const wrongSha1 = `sha1-${base64(new Uint8Array(20))}`;

      const { files } = await downloadPackage(url, { integrity: `${sha512} ${wrongSha1}` }, fetchOf(tarball));
      expect(files.get("index.js")).toBe("ok");
      await expect(downloadPackage(url, { integrity: `${wrongSha512} ${sha1}` }, fetchOf(tarball))).rejects.toThrow(
        url,
      );
    });

    it("throws, naming the tarball, when the SRI hash doesn't match", async () => {
      const tarball = await tgz(entries);
      const integrity = `sha512-${base64(await hash("SHA-512", await tgz([{ path: "package/other.js" }])))}`;
      await expect(downloadPackage(url, { integrity }, fetchOf(tarball))).rejects.toThrow(url);
    });

    it("falls back to the sha1 shasum without an SRI string", async () => {
      const tarball = await tgz(entries);
      const shasum = hex(await hash("SHA-1", tarball));
      await expect(downloadPackage(url, { shasum: shasum.toUpperCase() }, fetchOf(tarball))).resolves.toBeDefined();
      await expect(downloadPackage(url, { shasum: "0".repeat(40) }, fetchOf(tarball))).rejects.toThrow(url);
    });

    it("refuses a tarball the registry gives no integrity value for", async () => {
      await expect(downloadPackage(url, {}, fetchOf(await tgz(entries)))).rejects.toThrow(
        `${url} has no integrity value to check it against`,
      );
    });
  });

  it("gives up on a tarball that unpacks to more than the platform installs", async () => {
    // 65 MB of zeros compresses to a few kilobytes: a compression bomb.
    const entries = [{ path: "package/huge.js", content: new Uint8Array(65 * 1024 * 1024) }];
    await expect(download(entries)).rejects.toThrow(`${url} is larger than the platform installs (64 MB)`);
  });

  it("throws, naming the tarball, when the download fails", async () => {
    const missing = "https://registry.npmjs.org/missing/-/missing-1.0.0.tgz";
    const fetch = serving(await tgz([]));
    await expect(downloadPackage(missing, {}, { fetch })).rejects.toThrow(`Couldn't download ${missing}: HTTP 404`);
  });
});
