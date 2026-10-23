import { describe, expect, it } from "vitest";
import { readPublishTimes } from "../src/packages/publish-times";

const encoder = new TextEncoder();

/** A stream of `pieces`, pulled one at a time, that records how far it was read. */
function streamOf(pieces: Uint8Array[]) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === pieces.length) controller.close();
        else controller.enqueue(pieces[pulled++]!);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

/** `text` as UTF-8, cut at the given byte offsets. */
function cut(text: string | Uint8Array, ...offsets: number[]): Uint8Array[] {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const offset of [...offsets, bytes.length]) {
    pieces.push(bytes.subarray(start, offset));
    start = offset;
  }
  return pieces;
}

/** `text` as UTF-8 in pieces of `size` bytes. */
function inPieces(text: string | Uint8Array, size: number): Uint8Array[] {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  const pieces: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) pieces.push(bytes.subarray(start, start + size));
  return pieces;
}

const read = (pieces: Uint8Array[]) => readPublishTimes(streamOf(pieces).stream);

function manifest(name: string, version: string) {
  return {
    name,
    version,
    description: "Pads a string on the left",
    main: "index.js",
    scripts: { test: 'node -e "require(\\"./\\")"' },
    dependencies: {},
    _id: `${name}@${version}`,
    _npmVersion: "10.8.2",
    dist: {
      shasum: "c84a9f1a4f5e2d1e7b0b3a3b6a1c2d3e4f5a6b7c",
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: "sha512-AAAA",
    },
  };
}

const realisticTimes = {
  created: "2014-03-14T16:51:08.000Z",
  modified: "2026-10-21T09:12:45.123Z",
  "1.0.0": "2014-03-14T16:51:08.000Z",
  "1.1.0": "2016-01-04T11:02:33.000Z",
  "1.2.0": "2017-11-30T20:45:00.000Z",
  "2.0.0-beta.1": "2026-10-21T09:12:45.123Z",
};

const realistic = JSON.stringify({
  _id: "left-pad",
  _rev: "27-0b1c2d3e4f",
  name: "left-pad",
  "dist-tags": { latest: "1.2.0", beta: "2.0.0-beta.1" },
  versions: Object.fromEntries(
    ["1.0.0", "1.1.0", "1.2.0", "2.0.0-beta.1"].map((version) => [version, manifest("left-pad", version)]),
  ),
  time: realisticTimes,
  maintainers: [{ name: "stevemao", email: "steve@example.com" }],
  description: "String left pad",
  keywords: ["leftpad", "left", "pad", "padding", "string"],
  license: "WTFPL",
  readme: '# left-pad\n\n```js\nconst leftPad = require("left-pad");\nleftPad("foo", 5); // => "  foo"\n```\n',
  readmeFilename: "README.md",
});

// Quotes, backslashes, `\u` escapes, braces, brackets, multi-byte characters
// and decoy `time` keys all come before the real one.
const tricky = String.raw`{"_id":"time","name":"time","description":"Café ☕ 🌱 say \"time\":{\"1.0.0\":\"x\"} and C:\\","keywords":["time","{","[","}}]]"],"versions":{"1.0.0":{"name":"time","time":{"1.0.0":"1999-01-01T00:00:00.000Z"},"description":"\u0022time\u0022: { \\\" } \\\\"},"1.1.0":{"time":"not this one","x":[{"time":{}}]}},"time":{"created":"2020-01-01T00:00:00.000Z","1.0.0":"2020-01-02T00:00:00.000Z","1.1.0":"2020-01-03T00:00:00.000Z","note":"Crème brûlée 🍮 \"}\" \\"},"readme":"time"}`;
const trickyTimes = {
  created: "2020-01-01T00:00:00.000Z",
  "1.0.0": "2020-01-02T00:00:00.000Z",
  "1.1.0": "2020-01-03T00:00:00.000Z",
  note: 'Crème brûlée 🍮 "}" \\',
};

describe("readPublishTimes", () => {
  it("reads the release times of a realistic document", async () => {
    expect(await read(cut(realistic))).toEqual(realisticTimes);
  });

  it("agrees with JSON.parse on the tricky document", () => {
    expect(JSON.parse(tricky).time).toEqual(trickyTimes);
  });

  it("reads the same times wherever the document is cut in two", async () => {
    const bytes = encoder.encode(tricky);
    for (let offset = 0; offset <= bytes.length; offset++) {
      expect(await read(cut(bytes, offset)), `cut at byte ${offset}`).toEqual(trickyTimes);
    }
  });

  it("reads a document one byte at a time", async () => {
    expect(await read(inPieces(tricky, 1))).toEqual(trickyTimes);
    expect(await read(inPieces(realistic, 1))).toEqual(realisticTimes);
  });

  it("decodes multi-byte characters cut across pieces", async () => {
    const text = '{"description":"café ☕ 🌱","time":{"note":"🍮 é"}}';
    const bytes = encoder.encode(text);
    // Every cut inside a character, in the description and in `time` itself.
    const inside = [...bytes.keys()].filter((offset) => (bytes[offset]! & 0xc0) === 0x80);
    expect(inside).toHaveLength(10);
    for (const offset of inside) expect(await read(cut(bytes, offset))).toEqual({ note: "🍮 é" });
    expect(await read(cut(bytes, ...inside))).toEqual({ note: "🍮 é" });
  });

  it("isn't fooled by escaped quotes, backslashes and \\u escapes before time", async () => {
    const text = String.raw`{"a":"\"","b":"\\","c":"\\\"time\\\":{","d":"\u0022,\"time\":{\"x\":\"y\"}","e":"\u005c","time":{"1.0.0":"2020-01-01T00:00:00.000Z"}}`;
    expect(await read(cut(text))).toEqual({ "1.0.0": "2020-01-01T00:00:00.000Z" });
    expect(await read(inPieces(text, 1))).toEqual({ "1.0.0": "2020-01-01T00:00:00.000Z" });
  });

  it("isn't fooled by braces and brackets inside strings", async () => {
    const text = '{"a":"{{{[[[","versions":{"1.0.0":{"b":"}}}]]],"}},"c":["]","}"],"time":{"1.0.0":"2020-01-01T00:00:00.000Z"}}';
    expect(await read(cut(text))).toEqual({ "1.0.0": "2020-01-01T00:00:00.000Z" });
  });

  it("ignores time keys below the root and time as a string value", async () => {
    const text = JSON.stringify({
      name: "time",
      versions: { "1.0.0": { ...manifest("time", "1.0.0"), time: { "1.0.0": "1999-01-01T00:00:00.000Z" } } },
      maintainers: [{ time: { x: "y" } }],
      keywords: ["time"],
      time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
      readme: "time",
    });
    expect(await read(cut(text))).toEqual({ "1.0.0": "2020-01-01T00:00:00.000Z" });
  });

  it("returns no times for a document without time, having read all of it", async () => {
    const text = JSON.stringify({
      name: "no-times",
      versions: { "1.0.0": { ...manifest("no-times", "1.0.0"), time: { "1.0.0": "1999-01-01T00:00:00.000Z" } } },
      readme: "time",
    });
    const source = streamOf(inPieces(text, 16));
    expect(await readPublishTimes(source.stream)).toEqual({});
    expect(source.pulled()).toBe(inPieces(text, 16).length);
    expect(await read(cut("  {}  "))).toEqual({});
  });

  it("returns no times when time isn't an object", async () => {
    expect(await read(cut('{"time":"2020-01-01T00:00:00.000Z","versions":{}}'))).toEqual({});
    expect(await read(cut('{"time":["2020"],"versions":{}}'))).toEqual({});
    expect(await read(cut('{"time":null}'))).toEqual({});
  });

  it("keeps only the string entries of time", async () => {
    const text = JSON.stringify({
      name: "gone",
      time: {
        created: "2020-01-01T00:00:00.000Z",
        modified: "2020-02-01T00:00:00.000Z",
        unpublished: { time: "2020-02-01T00:00:00.000Z", versions: ["1.0.0"] },
      },
    });
    expect(await read(cut(text))).toEqual({
      created: "2020-01-01T00:00:00.000Z",
      modified: "2020-02-01T00:00:00.000Z",
    });
  });

  it("stops reading once time has closed, even before versions", async () => {
    const text = JSON.stringify({
      name: "early",
      time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
      versions: { "1.0.0": manifest("early", "1.0.0") },
      readme: "x".repeat(1000),
    });
    const pieces = inPieces(text, 32);
    const source = streamOf(pieces);
    expect(await readPublishTimes(source.stream)).toEqual({ "1.0.0": "2020-01-01T00:00:00.000Z" });
    expect(source.pulled()).toBeLessThan(pieces.length / 2);
    expect(source.cancelled()).toBe(true);
  });

  it("throws on a document that isn't a JSON object", async () => {
    for (const text of ["", "   ", "[]", '[{"time":{}}]', '"time"', "42", "null", '{"name":"x"} {}', '{"versions":{', '{"a":"}']) {
      await expect(read(cut(text)), JSON.stringify(text)).rejects.toThrow(SyntaxError);
    }
  });

  it("cancels the stream when the document isn't an object", async () => {
    const source = streamOf(inPieces('["time", {"time": {}}, "and more"]', 4));
    await expect(readPublishTimes(source.stream)).rejects.toThrow(SyntaxError);
    expect(source.cancelled()).toBe(true);
    expect(source.pulled()).toBe(1);
  });

  it("reads a 20 MB document in a few seconds at most", async () => {
    const readme = `# big\n\n${'Text with "quotes", \\backslashes\\, {braces}, [brackets], "time": {}, café 🌱.\n'.repeat(48)}`;
    const versions: Record<string, unknown> = {};
    const times: Record<string, string> = {
      created: "2010-01-01T00:00:00.000Z",
      modified: "2026-10-21T00:00:00.000Z",
    };
    for (let index = 0; index < 4500; index++) {
      const version = `${Math.floor(index / 100)}.${index % 100}.0`;
      versions[version] = { ...manifest("big", version), readme, time: { [version]: "1999-01-01T00:00:00.000Z" } };
      times[version] = new Date(Date.UTC(2010, 0, 1) + index * 3_600_000).toISOString();
    }
    const bytes = encoder.encode(
      JSON.stringify({ _id: "big", name: "big", "dist-tags": { latest: "44.99.0" }, versions, time: times, readme }),
    );
    expect(bytes.length).toBeGreaterThan(20_000_000);

    // Where a Worker's clock only moves at I/O, a timer either side brings it up to date.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    const start = Date.now();
    const result = await read(inPieces(bytes, 64 * 1024));
    await tick();
    const elapsed = Date.now() - start;

    expect(result).toEqual(times);
    expect(elapsed).toBeLessThan(5_000);
  });
});
