# Dependency types, virtual filesystems, editor and bundling for a Workers-hosted agent IDE

Researched 2026-10-12. Sources are official docs, source repositories, npm registry metadata and live requests to the CDNs and registries named. Where I measured something myself, such as a file size or a response header, the text says "measured" and links the URL I hit. "(inferred)" marks my own conclusions rather than something a source states.

## Implications for our design

1. **Type acquisition.** Don't drop `@typescript/ata` into the Worker unchanged. It ignores `package.json`, calls jsDelivr endpoints that have been deprecated since 2023, always takes the `latest` `@types` package, and fans out with unbounded `Promise.all`. A small fetcher of our own is a better fit (inferred). It should write each dependency's real `package.json` plus its `.d.ts`/`.d.mts`/`.d.cts` files to `/node_modules/<name>/` in the VFS and let TypeScript's own resolver handle `exports`, `typesVersions` and `@types` lookup. Registry tarballs work in a Worker: one subrequest per package, `DecompressionStream("gzip")`, and a small tar parser such as nanotar or modern-tar. Cache unpacked type sets in R2 keyed by `name@version`, since published versions are immutable.
2. **Check which TypeScript we mean.** Everything here that touches the compiler (ATA, `@typescript/vfs`, Monaco's TS worker, `@valtown/codemirror-ts`) uses the JavaScript compiler API. That API ends at TypeScript 6.x. TypeScript 7.0, the Go port and npm `latest` since July 2026, ships no API, and its WASM build is still a draft PR. If "TS as WASM in the Worker" means tsgo, none of these libraries plug in directly.
3. **Filesystem.** Make Durable Object SQLite the system of record, with one row per file and a 2 MB cap per row, and keep a `Map<string,string>` mirror in memory for the TS language service. `@typescript/vfs`'s `createSystem` is literally a `Map`. Before building our own, look at Cloudflare's `@cloudflare/shell` `Workspace`, which already persists to DO SQLite with optional R2 and backs the Think agent's read/write/edit/find/grep/bash tools. Add `just-bash` only if we want a bash tool. Its `IFileSystem` is async and small enough to back with the DO.
4. **Editor.** Use CodeMirror 6. Measured gzip is about 155 KB for basicSetup plus the JS/TS grammar. Monaco costs about 750 KB gzip for its core JS and CSS, plus 1.5 MB more for its TS worker. Server-computed diagnostics map straight onto CM6's push-style `setDiagnostics`. Monaco only earns its weight if we also want full in-browser IntelliSense from its bundled TS 5.9.3 worker.
5. **Agent tools.** Implement client-side tools over the DO VFS. Shape them like Claude Code's Read/Write/Edit/Glob/Grep, or use Anthropic's schema-less text editor tool. Both run in our process, so any backing store works. The Anthropic code execution tool can't use our store. It runs in Anthropic's container with no network.
6. **Preview bundling.** esbuild-wasm (14 MB wasm) looks loadable in a Worker going by its source, but its docs call it about 10x slower than native and say it is "primarily intended" for browsers. Rolldown and oxc WASM builds need threads and shared memory, which Workers don't have. The cheapest preview path is per-file transpile with the TypeScript we already load, plus an import map pointing bare specifiers at esm.sh (inferred). If we need a real bundle, run esbuild-wasm in the user's browser.

## Findings

### 1. Dependency type declarations without `npm install`

#### 1.1 `@typescript/ata` (the TS playground's Automatic Type Acquisition)

- Version 0.9.8, with peer dependency `typescript >=4.4.4` and no other dependencies ([package.json](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/package.json)).
- API: `setupTypeAcquisition({ projectName, typescript, logger, delegate })`. The delegate gets `receivedFile(code, path)`, `started()`, `progress(downloaded, total)` and `finished(vfs)`. The returned function takes source code and won't fetch a dependency twice ([README](https://github.com/microsoft/TypeScript-Website/tree/v2/packages/ata)).
- Pinning uses a comment on the import line, `// types: <version|tag>`. The default is `latest` ([README](https://github.com/microsoft/TypeScript-Website/tree/v2/packages/ata), [index.ts](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/src/index.ts)).
- Network: it uses only jsDelivr. The calls are `data.jsdelivr.com/v1/package/npm/{name}`, `/v1/package/resolve/npm/{name}@{ref}`, `/v1/package/npm/{name}@{version}/flat`, and file fetches from `cdn.jsdelivr.net/npm/{name}@{version}{file}`. It uses `config.fetcher` if given, otherwise global `fetch` ([apis.ts](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/src/apis.ts)).
- Those `/v1/package/` endpoints are deprecated. A live request still returns 200 but carries `Deprecation: Sun, 01 Jan 2023 00:00:00 GMT` and a `Link: rel="successor-version"` header pointing to `/v1/packages/npm/{name}@{version}?structure=flat` (measured: [legacy endpoint](https://data.jsdelivr.com/v1/package/npm/zod@3.23.8/flat)).
- File selection: it never interprets `package.json`. It downloads every file in the package matching `/\.d\.([^\.]+\.)?[cm]?ts$/i`. It also downloads `package.json` and stores it without reading it ([index.ts](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/src/index.ts)).
- `@types` fallback: if a package has no `.d.ts` files, it fetches `@types/<name>` at `latest`, with a `TODO` to use the user's version. Scoped names are mangled `@scope/name` to `scope__name`. Files land under `/node_modules/@types/...`. Because of a prefix comparison bug, `@types` fallback packages get no `package.json` ([index.ts](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/src/index.ts)).
- Recursion: it runs `ts.preProcessFile` on every downloaded file and recurses through `Promise.all` with no concurrency limit or depth cap. It reads the private `ts.libMap` ([index.ts](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/src/index.ts)).
- In a Worker the unbounded fan-out matters. Each file is one subrequest, and Workers allow 50 subrequests per request on Free and 10,000 on Paid ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). A package with hundreds of `.d.ts` files plus its transitive deps can blow the Free limit (inferred).

#### 1.2 esm.sh `X-TypeScript-Types`

- The README documents the `X-TypeScript-Types` header for Deno, and a `?no-dts` query that suppresses it ([esm.sh README](https://github.com/esm-dev/esm.sh)).
- Live behaviour (measured 2026-10-12):
  - `HEAD https://esm.sh/react@18.3.1` returns `X-TypeScript-Types: https://esm.sh/@types/react@~18.3.26/index.d.ts`, and `Access-Control-Expose-Headers` includes it, so browsers can read it.
  - `https://esm.sh/zod@3.23.8` points to `https://esm.sh/zod@3.23.8/index.d.ts`, which is the package's bundled types. `https://esm.sh/lodash@4.17.21` points to `https://esm.sh/@types/lodash@~4.17.20/index.d.ts`. So esm.sh does the `@types` fallback server-side.
  - The served `.d.ts` rewrites bare imports to absolute URLs, for example `import * as CSS from "https://esm.sh/csstype@3.2.3/index.d.ts";` in [@types/react's index.d.ts](https://esm.sh/@types/react@~18.3.26/index.d.ts). The response is `Content-Type: application/typescript`.
- Deno resolves module URLs and honours `X-TypeScript-Types` ([Deno TypeScript docs](https://docs.deno.com/runtime/fundamentals/typescript/)). `tsc` does not resolve `https:` specifiers. Using esm.sh types with plain TypeScript means rewriting URLs back to `/node_modules/...` paths or writing a custom `resolveModuleNameLiterals` host (inferred).

#### 1.3 jsDelivr and unpkg file listings

- jsDelivr data API, current endpoints ([OpenAPI spec](https://data.jsdelivr.com/v1/spec.yaml)):
  - `/v1/packages/npm/{package}` lists tags and versions.
  - `/v1/packages/npm/{package}/resolved?specifier=` resolves a range or tag to a version, or `null`.
  - `/v1/packages/npm/{package}@{version}?structure=tree|flat` lists files. It takes an exact version only and returns 403 if the package exceeds 100 MB.
  - `/v1/packages/npm/{package}@{version}/entrypoints` returns recommended JS/CSS entry files.
- The API "is free to use and imposes no rate limits", but asks you to get in touch for sustained 100+ RPM. The CDN doesn't serve npm packages over 150 MB ([data.jsdelivr.com README](https://github.com/jsdelivr/data.jsdelivr.com)).
- unpkg: append `?meta` to any package root or subdirectory to get JSON metadata. Ranges and tags redirect to an exact version, and unpkg runs on Cloudflare Workers ([unpkg.com](https://unpkg.com/)). Measured: [`https://unpkg.com/zod@3.23.8/?meta`](https://unpkg.com/zod@3.23.8/?meta) returns `{"package","version","prefix","files":[{"path","size","type","integrity"}]}`.
- Listing plus per-file fetch costs N+1 subrequests. A tarball costs one (inferred).

#### 1.4 Tarballs straight from registry.npmjs.org

- Abbreviated metadata: send `Accept: application/vnd.npm.install-v1+json` to get `name`, `modified`, `dist-tags` and `versions`. Each version has `dist.tarball` and `dist.integrity`. The npm docs warn the full document can be "over 10MB uncompressed" and say to prefer the abbreviated form ([npm registry docs](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)).
- The registry sends `Access-Control-Allow-Origin: *` on both the abbreviated packument and the tarball (measured), so the same code would work from a browser.
- Workers support `DecompressionStream` with `gzip`, `deflate` and `deflate-raw` ([Workers web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)). `node:zlib` is also listed as supported under `nodejs_compat` ([Workers Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)).
- Tar parsers that claim edge or Workers support:
  - [nanotar](https://github.com/unjs/nanotar) (0.3.0) is about 1 KB min+gzip. It provides `parseTar` and a `parseTarGzip` that uses `DecompressionStream` internally, plus `filter` and `metaOnly` options. It lists "Node.js (18+), Bun, Deno, Browsers, and Edge Workers".
  - [modern-tar](https://github.com/ayuhito/modern-tar) (0.8.5) is a zero-dependency streaming tar built on Web Streams. It "Works in browsers, Node.js, Cloudflare Workers". `just-bash` depends on it ([just-bash npm metadata](https://registry.npmjs.org/just-bash/latest)).
- Measured tarballs:
  - `@types/react@18.3.26` is 80,645 bytes. `react@18.3.1` is 81,751 bytes. `zod@3.23.8` is 115,982 bytes.
  - The top-level directory inside a tarball is not always `package/`. zod and react use `package/`, but `@types/react` uses `react v18.3/`. Strip the first path segment rather than a fixed prefix.
- Feasibility (inferred): typical type packages are tens to hundreds of KB gzipped, which fits easily in a 128 MB isolate ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Gunzip is native, and tar parsing is a linear JS scan. Verify `dist.integrity` (sha512) with `crypto.subtle.digest`. The packages to watch are large ones such as `@types/node`, or anything that ships its full source.

#### 1.5 Resolution: `types`, `typesVersions`, `exports`, `@types`

The [TypeScript modules reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html) says:

- With `moduleResolution` `node16`, `nodenext` or `bundler`, TypeScript follows `package.json` `"exports"` and always matches the `"types"` and `"default"` conditions, plus `import`/`require` (and `node` for node16/nodenext). `"exports"` blocks any subpath it doesn't list. `node10` ignores `exports`.
- `"typesVersions"` works in every mode, "however, the field is not read in situations when package.json "exports" are read."
- Without `exports`, TypeScript tries `"types"`, then `"typings"`, then `"main"` with extension substitution (`.js` to `.d.ts`, `.mjs` to `.d.mts`, `.cjs` to `.d.cts`).
- For each ancestor `node_modules`, it tries `node_modules/<pkg>` first, then `node_modules/@types/<pkg>`.

What this means for us (inferred):

- If the VFS holds each package's real `package.json` and declaration files at `/node_modules/<name>/`, the compiler does every resolution step itself. We shouldn't pick entry points by hand.
- Transitive type deps must be fetched too, for example `@types/react` importing `csstype`. Read `dependencies` and `peerDependencies` from each fetched `package.json` and resolve ranges with jsDelivr's `/resolved` endpoint or a semver match over the abbreviated packument.
- `@types` fallback: when a package has no declaration files, fetch `@types/<mangled-name>`. Pick a version matching the package's major.minor rather than ATA's `latest`.

#### 1.6 What StackBlitz, CodeSandbox and Val Town do

- **StackBlitz WebContainers** run Node.js "entirely inside your browser tab" ([intro](https://webcontainers.io/guides/introduction)). Dependencies install by running the real package manager inside the container, `webcontainerInstance.spawn('npm', ['install'])`, and pnpm or yarn also work ([tutorial](https://webcontainers.io/tutorial/3-installing-dependencies)). Types then come from an actual `node_modules` (inferred). WebContainers need `COOP: same-origin` and `COEP: require-corp` for SharedArrayBuffer ([headers guide](https://webcontainers.io/guides/configuring-headers)). "Licensing is required for production usage of the API in a commercial, for-profit setting" ([enterprise](https://webcontainers.io/enterprise)). It is client-only, so we can't use it from a Worker (inferred).
- **CodeSandbox Sandpack** "Fetches dependencies from our very own CDN". It has no private, git or `file:` dependencies ([bundlers](https://sandpack.codesandbox.io/docs/advanced-usage/bundlers)). Its FAQ says "Sandpack doesn't officially support any kind of language server" for TS errors in `SandpackCodeEditor`. Nodebox installs `node_modules` in the background from the Sandpack CDN ([FAQ](https://sandpack.codesandbox.io/docs/resources/faq)). There is no first-party type acquisition.
- **Val Town** code imports npm packages through `npm:` specifiers or esm.sh URLs ([import docs](https://docs.val.town/reference/import)). Its earlier editor integration, [`@valtown/codemirror-ts`](https://github.com/val-town/codemirror-ts), ran TypeScript in a Web Worker using `@typescript/vfs` `createDefaultMapFromCDN`, recommended `@typescript/ata` for npm types, and noted ATA "will not help you with your HTTP imports or prefixed imports". That repo is archived. Val Town now uses [vtlsp](https://github.com/val-town/vtlsp), which runs the Deno language server remotely and streams LSP over WebSocket to a CodeMirror client. The live demo talks to a Deno LS in a Cloudflare container. Deno handles `npm:` and URL imports and `X-TypeScript-Types` itself ([Deno docs](https://docs.deno.com/runtime/fundamentals/typescript/)).

#### 1.7 TypeScript version constraint

- npm `typescript@latest` is 7.0.2. It is a thin wrapper with per-platform native optional dependencies (`@typescript/typescript-linux-x64` and so on) and no WASM package. Its exports are `./unstable/*` API entry points ([registry metadata](https://registry.npmjs.org/typescript/7.0.2)).
- The announcement, dated July 8 2026, says "While TypeScript 7.0 is here, it does not ship with an API" and expects a new, different API in 7.1. It names `@typescript/typescript6` for tools that need the 6.0 API ([TS 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- A WASI `tsc.wasm` build that can drive the new IPC API "including in the browser" is an open draft PR, opened 2026-09-04 ([microsoft/TypeScript#64174](https://github.com/microsoft/TypeScript/pull/64174)).
- TypeScript 6.0.3's `lib/typescript.js` is 9,144,216 bytes raw and 1,649,756 bytes gzip (measured, [jsDelivr](https://cdn.jsdelivr.net/npm/typescript@6.0.3/lib/typescript.js)).

### 2. Virtual filesystem libraries usable in a Worker

Limits that shape every option: Workers memory is 128 MB per isolate ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). SQLite-backed Durable Objects get 10 GB per object, with "Largest string, BLOB, or table row" capped at 2 MB ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). They also have a synchronous KV API on `ctx.storage.kv`, and `transactionSync` for `ctx.storage.sql.exec` work that "complete[s] synchronously" ([DO SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).

| Option | What it gives you | Runs in Workers? | Persists to DO/SQLite? |
| --- | --- | --- | --- |
| Workers built-in `node:fs` | Node `fs` over a VFS with `/bundle` (read-only), `/tmp` and `/dev` | Yes, by default with `nodejs_compat` and compat date 2025-09-01 or later | No. `/tmp` is "not persistent and [is] unique to each request" |
| memfs 4.80.0 | In-memory Node `fs` plus browser File System API, adapters, CBOR/JSON snapshots | Probably, with `nodejs_compat` (inferred) | Snapshot by hand. No adapter |
| ZenFS `@zenfs/core` 2.7.7 (LGPL-3.0) | Node `fs` emulation with mountable backends | Likely; core backends are "cross-platform" | Yes, with a custom `StoreFS` store (inferred) |
| `@typescript/vfs` 1.6.5 | `ts.System` over a `Map`, plus a language-service environment | Yes. Pure Map, no fs | Not its job. Feed it from storage |
| `just-bash` 3.6.0 (Apache-2.0) | Simulated bash plus in-memory FS for agents | Yes. Cloudflare runs it in Dynamic Workers | Via a custom `IFileSystem` |
| `@cloudflare/shell` 0.4.3 (experimental) | Durable `Workspace` FS plus a `state.*` file-ops API and git | Yes. Built for Workers agents | Yes. SQLite plus optional R2 |

Details:

- **Workers `node:fs`.** All operations are synchronous. Timestamps are always the epoch. Files count toward isolate memory. There is no `fs.watch` and no glob APIs ([Workers fs docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)). It is only useful as per-request scratch space (inferred).
- **memfs.** It is an "in-memory Node.js fs module API and in-memory browser File System API" with adapters both ways ([memfs](https://github.com/streamich/memfs)). Its snapshot API has sync and async `toBinarySnapshot`/`fromBinarySnapshot` (CBOR `Uint8Array`) and `toJsonSnapshot` variants ([snapshot docs](https://github.com/streamich/memfs/blob/master/docs/snapshot/index.md)). It depends on `@jsonjoy.com/fs-node-builtins`, which `require`s `node:buffer`, `node:stream`, `node:path` and `node:events` (measured, e.g. [buffer.js](https://cdn.jsdelivr.net/npm/@jsonjoy.com/fs-node-builtins@4.80.0/lib/buffer.js)). All four are listed as supported in Workers ([Node.js APIs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)). A whole-tree snapshot would hit the 2 MB row cap quickly, so store per-file rows instead (inferred).
- **ZenFS.** Built-in backends are `InMemory`, `CopyOnWrite`, `Fetch`, `Port`, `Passthrough` and `SingleBuffer`. You mount several with `configure()` ([zen-fs/core](https://github.com/zen-fs/core)). `StoreFS` "implements inodes, directory listings, hard links, and transaction rollback on top of a key-value store". Synchronous Map-shaped storage implements `SyncMapStore`. Async stores answer sync calls from a cache and throw `EAGAIN` on a miss, so data must be preloaded ([backend authoring](https://zenfs.dev/core/backend-authoring/)). DO's synchronous KV and SQL APIs make a `SyncMapStore` over DO storage plausible (inferred). Check the LGPL-3.0 licence before adopting it.
- **`@typescript/vfs`.** `createSystem(files: Map<string,string>)` does every operation against the map ([source](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/typescript-vfs/src/index.ts)). `createVirtualTypeScriptEnvironment` returns `{ sys, languageService, getSourceFile, createFile, updateFile, deleteFile }`. `createDefaultMapFromCDN` pulls lib files from `https://playgroundcdn.typescriptlang.org/cdn/${version}/typescript/lib/`. The README warns this "could be up to about 1.5MB" ([README](https://github.com/microsoft/TypeScript-Website/tree/v2/packages/typescript-vfs)). In a Worker, bundle the lib `.d.ts` files with the script instead of fetching them per cold start (inferred). It needs the TS ≤6 JS API (see 1.7).
- **just-bash.** It describes itself as "a virtual bash environment with an in-memory filesystem, written in TypeScript and designed for AI agents". Each `exec()` gets fresh shell state, but the filesystem is shared across calls. Filesystems: `InMemoryFs`, `OverlayFs`, `ReadWriteFs` and `MountableFs`. Commands include `grep`, `rg`, `sed`, `awk`, `jq`, `find`, `diff`, `tar` and `gzip`. `curl` only exists when network allowlists are configured. Python (CPython WASM), sqlite and JS (QuickJS) are opt-in, and "All execution happens without VM isolation" ([README](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md)). The package has a `./browser` export with a 1.26 MB browser bundle (measured, [npm metadata](https://registry.npmjs.org/just-bash/latest)). `IFileSystem` is Promise-based (`readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `rm`, `cp`, `mv`, `symlink` and more), except `resolvePath` and `getAllPaths`, which are synchronous ([interface.ts](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/src/fs/interface.ts)). A synchronous `getAllPaths` means keeping an in-memory path index (inferred). Open bug: an `IFileSystem` that does async host work touching `process.env` or `setTimeout` during `exec()` throws `SecurityViolationError`. No maintainer response as of the page fetch ([issue #406](https://github.com/vercel-labs/just-bash/issues/406)).
- **Cloudflare first-party options.**
  - `@cloudflare/shell` is "Sandboxed JavaScript execution and filesystem runtime for Cloudflare Workers agents". Its `Workspace` has "durable file storage backed by SQLite + optional R2". The `state.*` API covers `readFile`, `writeFile`, `glob`, `diff`, `searchFiles` and `replaceInFiles`, plus `planEdits`/`applyEdits` with rollback by default. `createGit` uses isomorphic-git. It is "not a bash interpreter" and is marked experimental ([README](https://github.com/cloudflare/agents/blob/main/packages/shell/README.md)).
  - Think agents get `this.workspace`, "a virtual filesystem backed by Durable Object SQLite". Built-in tools are `read`, `write`, `edit` (find-and-replace that "supports fuzzy matching"), `list`, `find`, `grep`, `delete` and `bash`. By default bash snapshots up to 1,000 files and skips files over 1 MB. Custom backends plug in through `createWorkspaceTools` or per-operation interfaces ([Think tools](https://developers.cloudflare.com/agents/harnesses/think/tools/)).
  - `@cloudflare/computer` 0.5.0 is "a virtual filesystem that lives inside a Durable Object". It can run "just-bash in a Dynamic Worker" and is "NOT suitable for production use at this time" ([cloudflare/computer](https://github.com/cloudflare/computer)).

### 3. Browser editor: Monaco vs CodeMirror 6

Bundle size (measured 2026-10-12; gzip is the actual over-the-wire size from the CDN):

| Asset | Raw | Gzip |
| --- | --- | --- |
| Monaco 0.57.0 core chunk [`min/vs/editor-BdtEMBbM.js`](https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/min/vs/editor-BdtEMBbM.js) | 2,472,349 | 621,076 |
| Monaco [`editor.main.css`](https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/min/vs/editor/editor.main.css) | 390,829 | 127,302 |
| Monaco TS worker [`assets/ts.worker-g3pjEjl4.js`](https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/min/vs/assets/ts.worker-g3pjEjl4.js) | 7,034,765 | 1,549,495 |
| CM6 `codemirror@6.0.2` basicSetup, [esm.sh bundle](https://esm.sh/codemirror@6.0.2/es2022/codemirror.bundle.mjs) | 377,547 | 121,522 |
| `@lezer/javascript@1.5.6` (JS/TS/JSX grammar), [esm.sh](https://esm.sh/@lezer/javascript@1.5.6/es2022/javascript.mjs) | 77,983 | 29,836 |
| `@codemirror/lang-javascript@6.2.5` wrapper, [esm.sh](https://esm.sh/@codemirror/lang-javascript@6.2.5/es2022/lang-javascript.mjs) | 9,718 | 4,015 |

The esm.sh numbers are bundles of each package with its dependencies, so adding them up slightly overcounts shared code.

- **Built-in TypeScript.** Monaco 0.57.0 builds against `typescript ^5.9.3` ([package.json](https://github.com/microsoft/monaco-editor/blob/main/package.json)), and the worker embeds `"5.9.3"` (measured). Its TS defaults API has `addExtraLib(content, filePath)`, `setDiagnosticsOptions({ noSemanticValidation, noSyntaxValidation })` and `setEagerModelSync` ([monaco.d.ts](https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/monaco.d.ts)). Feeding acquired types to the browser worker means calling `addExtraLib` per file. CM6 has no TS language service. `@codemirror/lang-javascript` provides `typescriptLanguage` and `javascript({ typescript: true })` for parsing and highlighting only ([index.d.ts](https://cdn.jsdelivr.net/npm/@codemirror/lang-javascript@6.2.5/dist/index.d.ts)).
- **Showing server-side diagnostics.**
  - Monaco: `editor.setModelMarkers(model, owner, markers: IMarkerData[])` ([monaco.d.ts](https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/monaco.d.ts)). Turn off `noSemanticValidation` in the browser worker, or both checkers will report, possibly with different lib and type sets (inferred).
  - CM6: `linter(source: LintSource)`, where a `LintSource` returns `Diagnostic[]` or a Promise of them and runs "whenever the editor is idle", is pull-style. `setDiagnostics(state, diagnostics)` returns a transaction spec, which makes it push-style ([@codemirror/lint d.ts](https://cdn.jsdelivr.net/npm/@codemirror/lint@6.9.7/dist/index.d.ts)). Push suits diagnostics arriving over a WebSocket from the DO (inferred).
- **LSP over WebSocket.**
  - CM6: the official `@codemirror/lsp-client` 6.3.0 talks through a `Transport` with `send`/`subscribe`/`unsubscribe`. The README shows a minimal `simpleWebSocketTransport`. Extensions include `serverDiagnostics`, `serverCompletion`, `hoverTooltips`, `signatureHelp`, `renameSymbol`, `formatDocument`, `jumpToDefinition` and `findReferences`, and `languageServerExtensions()` bundles them all ([d.ts](https://cdn.jsdelivr.net/npm/@codemirror/lsp-client@6.3.0/dist/index.d.ts), [README](https://github.com/codemirror/lsp-client)). The GitHub repo was archived on 2026-04-15 and "has moved to https://code.haverbeke.berlin/codemirror/lsp-client". The npm package is still current. Val Town's [vtlsp](https://github.com/val-town/vtlsp) is a second CM6 LSP client, shipped with a WebSocket server and LS proxy.
  - Monaco: `monaco-languageclient` 11.0.2 depends on `@codingame/monaco-vscode-api` ^37.1.0 plus about 30 `@codingame/monaco-vscode-*` service overrides and language packs, `vscode-languageclient` and `vscode-ws-jsonrpc` ([npm metadata](https://registry.npmjs.org/monaco-languageclient/11.0.2)). `vscode-ws-jsonrpc` carries JSON-RPC over WebSocket, and servers can run in a browser worker or an external process ([README](https://github.com/TypeFox/monaco-languageclient)). It is a big dependency tree for a mini-IDE (inferred).
  - Either way, a TS language service inside a DO doesn't speak LSP. We would write a thin LSP shim or a small custom JSON protocol (inferred). A custom protocol driving `setDiagnostics` and a CM6 completion source is less work for v1 (inferred).
- **Other differences.** The Monaco FAQ answers "No." to mobile browser support ([monaco-editor README](https://github.com/microsoft/monaco-editor)). CM6 lists "Mobile Support: Use the platform's native selection and editing features on phones" ([codemirror.net](https://codemirror.net/)). For showing agent edits, Monaco has `createDiffEditor` ([monaco.d.ts](https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/monaco.d.ts)), and CM6 has `@codemirror/merge` 6.12.2, "A diff/merge view for CodeMirror" ([npm](https://registry.npmjs.org/@codemirror/merge/latest)).

### 4. Coding-agent tool surfaces over a virtual FS

- **Claude Code** lists `Read`, `Write`, `Edit`, `Glob`, `Grep`, `NotebookEdit`, `Bash`, `LSP` and others ([tools reference](https://code.claude.com/docs/en/tools-reference)).
  - `Edit` does exact string replacement with "no regex or fuzzy matching". `old_string` must match exactly and appear exactly once, unless `replace_all: true` is set. There is a read-before-edit check.
  - On macOS, Linux and WSL, Claude Code leaves `Glob` and `Grep` out of the default set and "Claude searches with `find` and `grep` through the Bash tool", which runs embedded `bfs` and `ugrep`.
- **Anthropic text editor tool** ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)). It is declared as `{"type": "text_editor_20250728", "name": "str_replace_based_edit_tool"}`, with optional `max_characters`. It is schema-less: "the schema is built into Claude's model and can't be modified". Commands:
  - `view` takes a file or directory path and an optional `view_range`, 1-indexed, where `-1` means end of file.
  - `str_replace` takes `path`, `old_str` and `new_str`.
  - `create` takes `path` and `file_text`.
  - `insert` takes `path`, `insert_line` (0 means the start of the file) and `insert_text`.
  - `undo_edit` was removed in `text_editor_20250429`.
  
  It is a client tool, so our code executes each command. That means it can sit directly on the DO VFS.
- **Anthropic memory tool**, `memory_20250818`, follows the same model: "The memory tool operates client-side ... You control where and how the data is stored". `/memories` "is a prefix that your handler maps onto real storage, such as ... keys in a database". Commands are `view`, `create`, `str_replace`, `insert`, `delete` and `rename`. The TS SDK has a `betaMemoryTool(handlers)` helper ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). It is a ready-made example of mapping an Anthropic file tool onto a custom store.
- **Anthropic code execution tool** ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)) runs in Anthropic's container:
  - Python 3.11, 1 CPU, 5 GiB RAM and 5 GiB disk.
  - "Internet access: Completely disabled", and "Containers expire 30 days after creation".
  - Files go in through the Files API (`container_upload`). Outputs come back as file IDs from `$OUTPUT_DIR`. Sub-tools are `bash_code_execution` and `text_editor_code_execution`.
  - ZDR status is `not-eligible`.
  
  It can't use our store or run `npm install`. Using it would mean copying files in and out through the Files API (inferred).
- **Managed Agents self-hosted sandboxes** move tool execution onto our infrastructure, but the worker needs "A Linux host ... with `/bin/bash` at that exact path". Cloudflare publishes a platform guide for its Sandbox containers ([docs](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)). That's a container, not a Worker.
- **Claude Agent SDK** "spawns and supervises a `claude` CLI subprocess that owns a shell, a working directory, and session files on disk" ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting)). It can't run inside a Worker (inferred).
- **OpenAI `apply_patch`**: `tools=[{"type": "apply_patch"}]`. Operations are `create_file`, `update_file` and `delete_file` in V4A diff format. "Your patch harness is responsible for interpreting the V4A diff format and applying changes" and reports back with `apply_patch_call_output`. Listed for GPT-5.1, 5.2, 5.4 and 5.5 ([docs](https://developers.openai.com/api/docs/guides/tools-apply-patch)).
- **Cloudflare Think** ships `read`, `write`, `edit`, `list`, `find`, `grep`, `delete` and `bash` over its DO workspace ([Think tools](https://developers.cloudflare.com/agents/harnesses/think/tools/)).

Takeaway (inferred): every established surface reduces to read with line numbers and ranges, create/overwrite, exact-unique-string replace, glob, regex search and sometimes bash. All of them are client-executed except Anthropic's code execution tool. Building these over DO storage is straightforward. A `typecheck` tool that returns the language service's diagnostics is the piece specific to our setup.

### 5. Bundling the agent's TypeScript for preview without native esbuild

- **esbuild-wasm 0.28.2.**
  - `esbuild.wasm` is 13,978,850 bytes raw and 3,785,500 gzip (measured, [listing](https://data.jsdelivr.com/v1/packages/npm/esbuild-wasm@0.28.2?structure=flat)).
  - The docs say: "The WebAssembly version is much, much slower than the native version. In many cases it is an order of magnitude (i.e. 10x) slower", and it "is primarily intended to only be used in the browser" ([getting started](https://esbuild.github.io/getting-started/)).
  - `initialize()` takes `wasmURL`, `wasmModule` ("The result of calling `new WebAssembly.Module(buffer)` ... for environments where it's not possible to download the WebAssembly module") and `worker` (default true; `false` runs in the calling thread) ([types.ts](https://github.com/evanw/esbuild/blob/main/lib/shared/types.ts)).
  - In 0.28.2's [`esm/browser.js`](https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.2/esm/browser.js), `worker: false` inlines the worker code as a real function. When given a `WebAssembly.Module`, it calls `WebAssembly.instantiate(wasm, go.importObject)` (measured source). Workers block `eval`, `new Function`, and `WebAssembly.instantiate` with a buffer, but allow pre-compiled modules ([web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/), [Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)). The old `new Function` blocker was [esbuild#2081](https://github.com/evanw/esbuild/issues/2081), closed in March 2022.
  - So importing `esbuild.wasm` as a module and calling `initialize({ wasmModule, worker: false })` should work in workerd. I haven't tested it (inferred).
  - There is no filesystem, so serve files from the VFS with `onResolve`/`onLoad` plugins, as the [plugins docs](https://esbuild.github.io/plugins/)' HTTP plugin does with remote files.
- **Worker constraints.** Script size limit is 64 MiB uncompressed with "no compressed size limit". Global scope must start within 1 s. Memory is 128 MB. CPU time is 30 s by default per request, configurable up to 5 min on Paid ([limits](https://developers.cloudflare.com/workers/platform/limits/)). "Threading is not possible in Workers", "the Web Worker API is not supported", and WASI is "experimental ... with only some syscalls implemented" ([Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)).
- **Rolldown and oxc WASM builds won't run in a Worker.** `@rolldown/browser` 1.2.13 ships an 11,171,585-byte `wasm32-wasi` binary. Its loader fetches the wasm by URL, instantiates it from an `ArrayBuffer`, allocates `new WebAssembly.Memory({ ..., shared: true })`, and sizes a worker pool from `navigator.hardwareConcurrency` (measured, [loader](https://cdn.jsdelivr.net/npm/@rolldown/browser@1.2.13/dist/rolldown-binding.wasi-browser.js)). `@oxc-transform/binding-wasm32-wasi` 0.153.0 (3.26 MB wasm) uses the same pattern: `fetch`, shared memory and `new Worker` (measured, [loader](https://cdn.jsdelivr.net/npm/@oxc-transform/binding-wasm32-wasi@0.153.0/transform.wasi-browser.js)). Every one of those is blocked or missing in Workers. In a browser, shared memory also needs cross-origin isolation (inferred).
- **swc.** `@swc/wasm-web` 1.16.18 provides `transformSync` after `initSwc()`. The docs cover transforming code and don't mention bundling ([swc wasm docs](https://swc.rs/docs/usage/wasm)). It is a transpiler, not a bundler.
- **Bun** doesn't apply in Workers.
- **Simplest path (inferred).** We already load TypeScript in the Worker for type checking. Its per-file transpile, plus an import map that points bare specifiers at esm.sh, gives a runnable ES-module preview with no bundler at all. Keep esbuild-wasm as an optional step in the user's browser when a single bundle is needed.

## Open questions

1. Which compiler runs in the Worker: TypeScript 6.0.x JS (9.1 MB raw, 1.65 MB gzip, mature API) or a tsgo WASM build (no stable API until 7.1, WASI build still a draft)? This decides whether ATA, `@typescript/vfs` and codemirror-ts are usable at all.
2. Does a TS program with realistic dependencies, such as React types plus `@types/node`, fit in 128 MB alongside the VFS mirror? Can the compiler load lazily so the 1 s startup limit isn't hit? This needs a spike.
3. Does esbuild-wasm actually initialise in workerd with `wasmModule` and `worker: false`, and what does a typical project bundle cost in CPU time? Not tested here.
4. Should type acquisition use the npm registry (one tarball per package, integrity hashes) or jsDelivr (exact-version listings, `/resolved` for ranges)? How do either behave under sustained traffic from Cloudflare egress IPs? jsDelivr asks to be contacted above 100 RPM.
5. Adopt `@cloudflare/shell` `Workspace` (experimental 0.x, edits roll back) or own a thin per-file SQLite table? The ZenFS route needs an LGPL-3.0 review.
6. Do we expose a bash tool through just-bash at all? If so, check issue #406's `SecurityViolationError` against our DO-backed `IFileSystem` before committing.
7. How do editor buffers and agent writes stay consistent: last-writer-wins per file, or OT/CRDT? Not researched here.
8. Should the browser also run a TS worker for instant completions, as Monaco or codemirror-ts do, or should everything go through the DO? The answer drives whether type files are shipped to the browser as well.
