import type { FakePackage } from "./fake-registry.ts";

// The Packages the fake npm registry serves in tests (see vitest.config.ts),
// besides the real Hono it serves from the platform's own copy.
// Ages are in hours: anything under 24 is too new to install.

const files = (name: string) => ({
  "index.js": `export const name = ${JSON.stringify(name)};\n`,
  "index.d.ts": "export declare const name: string;\n",
});

export const registryPackages: FakePackage[] = [
  // The Worker + React Template's Packages: just enough of React and its
  // types for the Template to pass a Check and bundle.
  {
    name: "react",
    versions: {
      "19.3.1": {
        ageHours: 240,
        files: {
          "package.json": JSON.stringify({
            name: "react",
            version: "19.3.1",
            exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" },
          }),
          "index.js": [
            "export const StrictMode = ({ children }) => children;",
            "export const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}];",
            "export const useEffect = () => {};",
            "",
          ].join("\n"),
          "jsx-runtime.js":
            "export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;\nexport const Fragment = Symbol('Fragment');\n",
        },
      },
    },
  },
  {
    name: "react-dom",
    versions: {
      "19.3.1": {
        ageHours: 240,
        files: {
          "package.json": JSON.stringify({
            name: "react-dom",
            version: "19.3.1",
            // As React's own, which lists its Node build before its browser build.
            exports: {
              "./client": "./client.js",
              "./server": { node: "./server.node.js", worker: "./server.browser.js", browser: "./server.browser.js", default: "./server.node.js" },
            },
          }),
          "client.js": "export const createRoot = (element) => ({ render: (node) => { element.textContent = String(node.type); } });\n",
          // Renders the fake React's elements, calling function components with their props.
          "server.browser.js": [
            "const escape = (text) => String(text).replace(/[&<>\"]/g, (char) => `&#${char.charCodeAt(0)};`);",
            "export function renderToString(node) {",
            "  if (node == null || typeof node === 'boolean') return '';",
            "  if (Array.isArray(node)) return node.map(renderToString).join('');",
            "  if (typeof node !== 'object') return escape(node);",
            "  const { type, props } = node;",
            "  if (typeof type === 'function') return renderToString(type(props));",
            "  const attributes = Object.entries(props)",
            "    .filter(([name, value]) => name !== 'children' && typeof value !== 'function')",
            "    .map(([name, value]) => ` ${name === 'className' ? 'class' : name}=\"${escape(value)}\"`)",
            "    .join('');",
            "  return `<${type}${attributes}>${renderToString(props.children)}</${type}>`;",
            "}",
            "",
          ].join("\n"),
          "server.node.js": 'export const renderToString = () => {\n  throw new Error("The Node build");\n};\n',
        },
      },
    },
  },
  {
    name: "@types/react",
    versions: {
      "19.3.0": {
        ageHours: 240,
        files: {
          "package.json": JSON.stringify({
            name: "@types/react",
            version: "19.3.0",
            exports: { ".": { types: "./index.d.ts" }, "./jsx-runtime": { types: "./jsx-runtime.d.ts" } },
          }),
          "index.d.ts": [
            'import type { JSX } from "./jsx-runtime";',
            "export type ReactNode = string | number | boolean | null | undefined | JSX.Element | ReactNode[];",
            "export type SetStateAction<S> = S | ((previous: S) => S);",
            "export declare function useState<S>(initial: S | (() => S)): [S, (action: SetStateAction<S>) => void];",
            "export declare function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;",
            "export declare function StrictMode(props: { children?: ReactNode }): JSX.Element;",
            "",
          ].join("\n"),
          "jsx-runtime.d.ts": [
            "export declare namespace JSX {",
            "  interface Element { type: unknown; props: unknown }",
            "  interface ElementChildrenAttribute { children: {} }",
            "  interface IntrinsicElements { [name: string]: { [prop: string]: unknown } }",
            "}",
            "export declare function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element;",
            "export declare const jsxs: typeof jsx;",
            "export declare const Fragment: unique symbol;",
            "",
          ].join("\n"),
        },
      },
    },
  },
  {
    name: "@types/react-dom",
    versions: {
      "19.3.0": {
        ageHours: 240,
        files: {
          "package.json": JSON.stringify({
            name: "@types/react-dom",
            version: "19.3.0",
            exports: { "./client": { types: "./client.d.ts" }, "./server": { types: "./server.d.ts" } },
          }),
          "server.d.ts": 'import type { ReactNode } from "react";\nexport declare function renderToString(element: ReactNode): string;\n',
          "client.d.ts": [
            'import type { ReactNode } from "react";',
            "export interface Root { render(children: ReactNode): void }",
            "export declare function createRoot(container: Element | DocumentFragment): Root;",
            "",
          ].join("\n"),
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
