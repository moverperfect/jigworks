import { describe, expect, it } from "vitest";
import { packageListPaths, packageReadChars, readPackage, type PackageDeclarations } from "../src/agent";

// read_package's answers, from Packages kept in memory. test/conversation.test.ts reads a real one through a Turn.

function installed(files: Record<string, Record<string, string>>): PackageDeclarations {
  return {
    status: () => ({ state: "installed", packages: Object.keys(files).map((name) => ({ name, version: "1.0.0" })), warnings: [], error: null }),
    declarationPaths: (name) => Object.keys(files[name] ?? {}).sort(),
    declaration: (name, path) => files[name]?.[path] ?? null,
  };
}

const packages = installed({
  "@scope/kit": { "package.json": "{}", "dist/index.d.ts": "export declare const a: 1;\n", "dist/more/b.d.ts": "export {};\n" },
});

describe("read_package", () => {
  it("lists a Package's files, or those in a folder", () => {
    expect(readPackage(packages, "@scope/kit")).toBe(
      "@scope/kit 1.0.0: its type declarations and package.json files, by their paths from /node_modules/@scope/kit/:\ndist/index.d.ts\ndist/more/b.d.ts\npackage.json",
    );
    expect(readPackage(packages, "@scope/kit", "/node_modules/@scope/kit/dist/more")).toBe(
      "@scope/kit 1.0.0: its type declarations and package.json files in dist/more, by their paths from /node_modules/@scope/kit/:\ndist/more/b.d.ts",
    );
  });

  it("reads a file by its path from the Package's folder, or from /", () => {
    const whole = "/node_modules/@scope/kit/dist/index.d.ts, all 2 lines:\nexport declare const a: 1;\n";
    expect(readPackage(packages, "@scope/kit", "dist/index.d.ts")).toBe(whole);
    expect(readPackage(packages, "@scope/kit", "./dist/index.d.ts")).toBe(whole);
    expect(readPackage(packages, "@scope/kit", "/node_modules/@scope/kit/dist/index.d.ts")).toBe(whole);
  });

  it("cuts a long file at a line, saying where to read on from", () => {
    const line = "x".repeat(999);
    const text = Array.from({ length: 100 }, () => line).join("\n");
    const big = installed({ big: { "index.d.ts": text } });
    const perRead = Math.floor(packageReadChars / 1000);
    const first = readPackage(big, "big", "index.d.ts");
    expect(first.split("\n")[0]).toBe(`/node_modules/big/index.d.ts, lines 1 to ${perRead} of 100:`);
    expect(first).toContain(`(Cut at line ${perRead} to keep it short. Read on with from: ${perRead + 1}.)`);
    expect(first.length).toBeLessThan(packageReadChars + 200);
    const last = readPackage(big, "big", "index.d.ts", 97);
    expect(last).toBe(`/node_modules/big/index.d.ts, lines 97 to 100 of 100:\n${[line, line, line, line].join("\n")}`);
    expect(() => readPackage(big, "big", "index.d.ts", 101)).toThrow("/node_modules/big/index.d.ts has only 100 lines.");
  });

  it("cuts a line longer than it gives at once, saying so", () => {
    const minified = installed({ min: { "index.d.ts": `${"y".repeat(packageReadChars + 10)}\nexport {};` } });
    const read = readPackage(minified, "min", "index.d.ts");
    expect(read).toContain(`\n${"y".repeat(packageReadChars)}\n(Line 1 is longer than 48,000 characters, so it's cut there.)`);
    expect(read).toContain("Read on with from: 2.");
  });

  it("lists only so many paths, saying how to narrow it", () => {
    const many = installed({ many: Object.fromEntries(Array.from({ length: packageListPaths + 5 }, (_, i) => [`types/f${String(i).padStart(4, "0")}.d.ts`, ""])) });
    const listed = readPackage(many, "many").split("\n");
    expect(listed).toHaveLength(packageListPaths + 2);
    expect(listed.at(-1)).toBe(`and 5 more. List on with from: ${packageListPaths + 1}, or give a folder as path, such as types, to list only what's in it.`);
    expect(readPackage(many, "many", "types", packageListPaths + 1).split("\n").slice(1)).toEqual(
      Array.from({ length: 5 }, (_, i) => `types/f${String(packageListPaths + i).padStart(4, "0")}.d.ts`),
    );
    expect(readPackage(many, "many", "types").split("\n").at(-1)).toBe(`and 5 more. List on with from: ${packageListPaths + 1}.`);
    expect(() => readPackage(many, "many", "types", packageListPaths + 6)).toThrow(`There are only ${packageListPaths + 5} to list in types.`);
  });

  it("says when a Package isn't installed, or has nothing at the path", () => {
    expect(() => readPackage(packages, "zod")).toThrow("zod isn't installed. The installed ones are @scope/kit.");
    expect(() => readPackage(installed({}), "zod")).toThrow("zod isn't installed. None are installed.");
    expect(() => readPackage(packages, "@scope/kit", "dist/index.js")).toThrow(
      "@scope/kit has no type declarations or package.json at /node_modules/@scope/kit/dist/index.js. Call read_package with only its name to list them.",
    );
  });
});
