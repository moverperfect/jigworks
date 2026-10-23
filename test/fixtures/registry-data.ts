import type { FakePackage } from "./fake-registry.ts";

// The Packages the fake npm registry serves in tests (see vitest.config.ts).
// Ages are in hours: anything under 24 is too new to install.

const files = (name: string) => ({
  "index.js": `export const name = ${JSON.stringify(name)};\n`,
  "index.d.ts": "export declare const name: string;\n",
});

export const registryPackages: FakePackage[] = [
  {
    // The Worker Template's one Package.
    name: "hono",
    versions: {
      "4.13.13": {
        ageHours: 240,
        files: {
          "package.json": JSON.stringify({
            name: "hono",
            version: "4.13.13",
            type: "module",
            main: "dist/index.js",
            types: "dist/index.d.ts",
          }),
          "dist/index.js": "export class Hono {}\n",
          // Just enough of Hono's types for the Worker Template to pass a Check.
          "dist/index.d.ts": [
            "export interface Context<E extends { Bindings?: object } = {}> {",
            '  env: E["Bindings"];',
            "  req: { param(name: string): string };",
            "  text(text: string): Response;",
            "  json(value: unknown): Response;",
            "}",
            "export declare class Hono<E extends { Bindings?: object } = {}> {",
            "  get(path: string, handler: (c: Context<E>) => Response | Promise<Response>): this;",
            "  post(path: string, handler: (c: Context<E>) => Response | Promise<Response>): this;",
            "  fetch(request: Request): Response | Promise<Response>;",
            "}",
            "",
          ].join("\n"),
          "dist/index.js.map": "{}",
          "README.md": "# Hono\n",
        },
      },
    },
  },
  {
    name: "@fake/a",
    versions: {
      "1.0.0": { ageHours: 100, dependencies: { "@fake/shared": "^1.0.0" }, files: files("a") },
      "1.1.0": { ageHours: 2, dependencies: { "@fake/shared": "^1.0.0" }, files: files("a") },
    },
  },
  {
    name: "@fake/b",
    versions: { "2.0.0": { ageHours: 100, dependencies: { "@fake/shared": "^2.0.0" }, files: files("b") } },
  },
  {
    name: "@fake/shared",
    versions: {
      "1.0.0": { ageHours: 300, files: files("shared") },
      "1.2.0": { ageHours: 200, files: files("shared") },
      "1.3.0": { ageHours: 1, files: files("shared") },
      "2.0.0": { ageHours: 100, files: files("shared") },
    },
  },
  {
    name: "@fake/plugin",
    versions: { "1.0.0": { ageHours: 100, peerDependencies: { "@fake/host": "^3.0.0" }, files: files("plugin") } },
  },
  {
    name: "@fake/host",
    versions: { "2.0.0": { ageHours: 100, files: files("host") } },
  },
  {
    name: "@fake/native",
    versions: { "1.0.0": { ageHours: 100, os: ["linux"], cpu: ["x64"], files: files("native") } },
  },
  {
    name: "@fake/with-native",
    versions: {
      "1.0.0": { ageHours: 100, optionalDependencies: { "@fake/native": "1.0.0" }, files: files("with-native") },
    },
  },
  {
    name: "@fake/too-new",
    versions: { "1.0.0": { ageHours: 3, files: files("too-new") } },
  },
  {
    // 1.1.0 is in the compact document but missing from the full one's publish times.
    name: "@fake/untimed",
    versions: {
      "1.0.0": { ageHours: 100, files: files("untimed") },
      "1.1.0": { ageHours: 1, omitPublishTime: true, files: files("untimed") },
    },
  },
  {
    name: "@fake/tag-user",
    versions: { "1.0.0": { ageHours: 100, dependencies: { "@fake/shared": "latest" }, files: files("tag-user") } },
  },
  {
    name: "@fake/aliased",
    versions: {
      "1.0.0": { ageHours: 100, dependencies: { "@fake/shared": "npm:@fake/host@2.0.0" }, files: files("aliased") },
    },
  },
  {
    name: "@types/fake",
    versions: { "1.0.0": { ageHours: 100, files: { "index.d.ts": "export declare const fake: true;\n" } } },
  },
];
