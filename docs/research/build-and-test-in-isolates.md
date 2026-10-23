# Building and testing inside Workers isolates

Researched 2026-10-13. GitHub links are pinned to the commits or tags I read: cloudflare/agents [`b1e3614`][agents-sha] (2026-10-13), cloudflare/vibesdk [`9da158d`][vibe-sha] (still `main`), cloudflare/cloudflare-os [`8001c4b`][cfos-sha2] (2026-10-13), tailwindlabs/tailwindcss v4.3.3 [`c2b24dd`][tw-sha], esbuild v0.28.1 and workerd [`3371391`][wd-sha]. npm versions are the ones that were `latest` today unless stated. "Measured" means I read a file listing or a binary's headers myself. No package code was run. "(inferred)" marks my own reading, which no source states directly.

Related notes, not repeated here:

- [cloudflare-platform.md](./cloudflare-platform.md) §1 (limits), §4 (Dynamic Workers and worker-bundler) and §5 (vibesdk and Cloudflare OS). §4.1 below corrects one point in §5.
- [deps-vfs-editor.md](./deps-vfs-editor.md) §5: esbuild-wasm's loading path, and why Rolldown and oxc can't load.
- [ts-rust.md](./ts-rust.md): the type-checker that shares the Workspace's isolate.

## Verdict

**Both Templates can probably be built inside isolates, but only with a narrower toolchain than the same projects use on a laptop. Nobody has published memory or timing numbers, so a spike has to come next.**

- **The Hono Worker is proven ground.** `@cloudflare/worker-bundler` runs esbuild-wasm inside workerd and bundles TypeScript Workers with npm dependencies, from inside a Durable Object. Cloudflare's playgrounds, vibesdk and the bundler's own tests all do this (§1, §4).
- **Nobody I could find has built a React front-end inside workerd.** vibesdk ships browser files untranspiled, and Cloudflare OS ships hand-written JS (§4). worker-bundler's `createApp({ client })` should bundle React (inferred). But it drops CSS imported from JS, ignores `tsconfig.json`, treats `.module.css` as global CSS, and turns unresolved imports into silent externals (§1.4, §1.5).
- **Vite and Rolldown can't run in workerd.** So the platform's build doesn't use the project's Vite config. We reproduce what the config does instead (§3).
- **Tailwind v4 can run, apart from its scanner.** Its compiler is pure JS. Its Rust scanner can't run, because the Wasm build needs threads and shared memory, so we extract class names ourselves. The compiler API is officially internal (§2).
- **We can hand worker-bundler our own packages.** A synchronous `FileSystem` over DO SQLite with a flat `node_modules/` makes its installer a no-op. Nested versions need its unsupported plugin hook (§1.6).
- **Memory is the main unknown.** esbuild-wasm's heap stays in the isolate after the first build, alongside ts-rust and Think, within 128 MB. That is plausible for small projects but unmeasured. The build can move to a separate isolate if needed (§5).
- **Tests need a runner of our own.** Real vitest and Cloudflare's vitest integration both need Node. vitest's portable parts can run in a Dynamic Worker behind a vitest-compatible shim. Hono Workers are fully testable that way. React is limited to logic and server-rendered HTML, because jsdom and happy-dom can't run in workerd (§6).

## Implications for our design

These follow from the findings but are my own conclusions, so read them as (inferred). §7 has the detail.

1. **Build with worker-bundler, but feed it ourselves.** Give it a synchronous `FileSystem` over the Workspace's SQLite, with our downloaded packages laid out flat under `node_modules/`. Its installer then does nothing, so its weak spots never run: no lockfile, no integrity check, versions picked by timing (§1.6, §1.7).
2. **Turn silent externals into build errors.** After each build, fail if the output still imports a bare specifier other than `cloudflare:*` or `node:*` (§1.5).
3. **Write the React Template for this bundler, not for Vite.** CSS is linked from `index.html` and built by a separate Tailwind step. No CSS imports from TypeScript, no CSS modules, no `@/` path aliases, no image imports, and JSX set to `automatic` explicitly (§1.4, §2, §7.3).
4. **The project's `vite.config.ts` is for export only.** Nothing on the platform reads it (§3).
5. **Measure memory before deciding where the build runs.** Start in the Workspace DO with a lazy import. Keep a builder Worker or Dynamic Worker as the fallback, because esbuild's heap never leaves the isolate once loaded (§5).
6. **Build once per content hash and keep the output.** Load it with `LOADER.get(hash)`, as vibesdk does per commit (§4.1).
7. **Re-check the file-store choice.** Cloudflare has an open PR stack that deprecates `@cloudflare/shell` in favour of `@cloudflare/computer` (§8).

## Findings

### 1. `@cloudflare/worker-bundler` 0.2.6

Read at cloudflare/agents [`b1e3614`][agents-sha] (2026-10-13). npm `latest` is 0.2.6, published 2026-10-07 ([npm][wb-npm]).

#### 1.1 What it is and where it runs

- **Status.** The README still opens with "Experimental… Not recommended for production use" ([README L3][wb-readme]). It also still calls Worker Loader "closed beta" (L5), which is out of date.
- **Dependencies.** `esbuild-wasm` pinned at exactly 0.28.1, plus `sucrase`, `es-module-lexer`, `resolve.exports`, `semver`, `fflate`, `smol-toml`, `typescript ^6.0.3` and `@typescript/vfs` ([package.json][wb-pkg]). npm `latest` for esbuild-wasm is 0.28.2.
- **workerd only.** It "only runs inside the Cloudflare Workers runtime (`workerd`)… It will not work under plain Node.js" ([README L7-11][wb-readme-runtime]). It checks `navigator.userAgent === "Cloudflare-Workers"` and throws otherwise ([bundler.ts L342-368][wb-bundler-guard]).
- **Inside a Durable Object: yes.** Cloudflare's `worker-bundler-playground` calls `createApp` from an `AIChatAgent`, which is a Durable Object, and mounts the result as a facet ([server.ts L58-262][ex-wbp-server]). vibesdk's `SpaceDO` does the same ([cloudflare-platform.md](./cloudflare-platform.md) §5). The proposed self-modifying harness example bundles in a DO and runs each turn in a Dynamic Worker. Its deployed Worker carries the esbuild Wasm at 13,940 KiB raw and 3,790 KiB gzip ([rfc-self-modifying-harness.md L318-327][rfc-smh]).
- **Cloudflare's docs point here.** The Dynamic Workers getting-started page says TypeScript and npm dependencies must be bundled before `load()` or `get()`, and uses `createWorker` for it ([getting started][dw-start]).
- **Where sucrase fits.** Sucrase is only used when `bundle: false`. That "transform-only mode" skips esbuild and uses "sucrase + naïve module resolution", so `define`, `loader`, `conditions`, plugins and the JSX options do nothing there ([README L499-503][wb-readme-adv], [transformer.ts][wb-transformer]). The normal path is esbuild-wasm alone.

#### 1.2 Inputs and outputs

- **`createWorker(options)`** takes `files` (a `Record<string,string>` or a `FileSystem`), `entryPoint`, `bundle` (default `true`), `externals`, `target` (default `es2022`), `minify`, `sourcemap` (inline), `registry`, `jsx`, `jsxImportSource`, `define`, `loader`, `conditions`, `virtualModules` and the plugin escape hatch. It returns `{ mainModule, modules, wranglerConfig?, warnings? }` ([README L112-143][wb-readme-api]).
- **One output module.** With bundling on, the result is always a single ESM module called `bundle.js` ([bundler.ts L225-264][wb-bundler-build]).
- **Entry point.** It uses the explicit option, then `main` in a wrangler config, then `exports`/`module`/`main` in `package.json`, then `src/index.ts` and similar defaults ([README L357-364][wb-readme-entry]).
- **Wrangler config.** It reads `wrangler.toml`, `.json` or `.jsonc` from the files. If `nodejs_compat` is set, esbuild's platform is `node`, otherwise `browser`. `cloudflare:*` imports are always external ([bundler.ts L230][wb-bundler-build], [index.ts L110-115][wb-index]).
- **`createApp(options)`** adds `server`, `client` (one entry or a list), `assets` (pathname to string or `ArrayBuffer`) and `assetConfig`. It returns everything `createWorker` does plus `assets`, `assetManifest`, `assetConfig` and `clientBundles` ([README L145-179][wb-readme-app]).
- **README mismatch.** The `createApp` table lists `virtualModules`, but `createApp` neither declares nor passes it ([app.ts L37-154][wb-app], [README L167][wb-readme-app]).

#### 1.3 Client bundles, assets and the manifest

- **Order of work.** Install dependencies, bundle each client entry, build the asset manifest, then bundle the server ([app.ts L184-372][wb-app]).
- **Client bundles.** Each entry is bundled on its own for the browser, with the target fixed at `es2022` ([app.ts L245-277][wb-app-client]).
- **Client file names.** `src/` is stripped and `.ts`/`.tsx`/`.js`/`.jsx` becomes `.js`, so `src/main.tsx` is served at `/main.js` ([app.ts L268-276][wb-app-client]). Names carry no content hash, so the asset handler sends `max-age=0, must-revalidate` ([README L349-355][wb-readme-cache]).
- **HTML is not touched.** No `index.html` is generated or rewritten. The caller passes HTML as an asset, and it must point at `/main.js` itself ([README L54-106][wb-readme-app-quick]). User assets "are NOT processed by the bundler" ([app.ts L57-62][wb-app]).
- **Manifest.** `buildAssetManifest` records a content type and a SHA-256 ETag per pathname ([asset-handler.ts L136-178][wb-assets]).
- **Serving.** `handleAssetRequest(request, manifest, storage, config)` returns a `Response` or `null`. It handles ETags and 304s, trailing-slash modes, SPA and 404-page fallbacks, redirects and custom headers ([README L181-355][wb-readme-handler]).
- **Assets stay out of the isolate.** The host serves them and forwards everything else to the Dynamic Worker. Storage is any object with `get(pathname)`, so DO SQLite works as a store (inferred; the README shows memory, KV, R2 and Workspace) ([README L208-286][wb-readme-storage]).
- **Server as a DO.** If the server exports a named `DurableObject` class, the host can mount it as a facet with its own SQLite ([README L366-425][wb-readme-do]).

#### 1.4 What it can bundle

| Input | Works? | Detail |
| --- | --- | --- |
| `.ts`, `.mts`, `.tsx`, `.jsx`, `.js` | Yes | Loader chosen by extension ([bundler.ts L316-336][wb-loader]). JSX defaults to esbuild's classic transform. Set `jsx: "automatic"` and `jsxImportSource: "react"` for the React 17+ runtime ([README L505-516][wb-readme-jsx]). |
| `tsconfig.json` settings | No | esbuild-wasm's browser build runs with `hasFS: false`, and its Go `fs` shim answers `open` and `stat` with `ENOSYS` ([browser.js L1945, L2661][esb-browser]). worker-bundler passes no `tsconfigRaw`. So `jsx`, `paths` and decorator settings in `tsconfig.json` are ignored (inferred). |
| JSON | Yes | `json` loader. A relative import without the `.json` extension won't resolve, because the extension list is `.ts .tsx .js .jsx .mts .mjs` ([bundler.ts L297-311][wb-relative]). |
| CSS imported from JS | No, silently dropped | esbuild puts CSS imported from JS into "a sibling CSS output file" ([esbuild content types][esb-css]), named with `.css` even when `outfile` is `bundle.js` ([linker.go L4044-4060][esb-outfile]). esbuild orders JS chunks before CSS chunks ([linker.go L3959-3986][esb-linker]). worker-bundler keeps only `outputFiles[0]` ([bundler.ts L246-258][wb-bundler-build]), and its README says secondary outputs are discarded ([README L563][wb-readme-loader]). So `import "./styles.css"` produces no CSS (inferred; no test covers it). |
| A CSS file as its own client entry | Yes, going by the code (untested) | For a CSS entry, esbuild uses the `outfile` name verbatim, so the CSS lands in `bundle.js`, the only output ([linker.go L4044-4060][esb-outfile]). `createApp` then renames only JS extensions, so `client: ["src/main.tsx", "src/styles.css"]` should serve bundled CSS, `@import`s included, at `/styles.css` ([app.ts L268-276][wb-app-client]) (inferred). `url()` references to fonts or images need to stay external and be served as assets (inferred). |
| CSS modules | No | Every `.css` file gets the `css` loader ([bundler.ts L334][wb-loader]), which overrides esbuild's default `local-css` for `.module.css` ([esbuild content types][esb-css]). `local-css` isn't in the allowed loader set ([README L548-561][wb-readme-loader]). |
| Images and fonts | Only as static assets | `FileSystem.read` returns a string ([file-system.ts L1-38][wb-fs]), and the `file`/`copy` loaders are excluded ([README L563][wb-readme-loader]). Pass binaries in `assets` as `ArrayBuffer` and reference them by URL. SVG as `text` works ([README L533-546][wb-readme-loader]). |
| Wasm | No, in practice | The installer drops `.wasm` from packages ([README L873][wb-readme-lim]). A `binary` loader would need `WebAssembly.instantiate(bytes)`, which Workers block (inferred). |
| CommonJS packages | Yes | esbuild bundles `require`. React's CJS entry works because esbuild defines `process.env.NODE_ENV` as `"production"` when all minification is on and `"development"` otherwise ([esbuild API][esb-platform]). |
| CommonJS that `require()`s a Node built-in | Probably fails when the Worker starts | Built-ins stay external, and in ESM output esbuild turns `require("os")` into a call that throws "Dynamic require of "os" is not supported" ([esbuild#1921][esb-1921], open). worker-bundler has no plugin to rewrite these (inferred from the code). |

#### 1.5 How it resolves `node_modules`

- **Its own resolver, not esbuild's.** An internal plugin claims every import with `filter: /.*/` ([bundler.ts L99-172][wb-plugin]). esbuild's resolver never runs (inferred).
- **Flat, root-only.** A bare import looks only at `node_modules/<name>/package.json` at the root ([resolver.ts L112-128][wb-resolver-pkg]). Nested `node_modules` aren't searched. So there is one version per package name ([README L871][wb-readme-lim]).
- **Conditions.** `exports` goes through `resolve.exports` with conditions `["import", "browser"]` ([resolver.ts L64-73][wb-resolver]). `resolve.exports` also adds `default`, `import` and, because its `browser` option is off, `node`. "The matching order/priority is always determined by the "exports" map's key order" ([resolve.exports README][resolve-exports]). So whichever of `node` and `browser` a package lists first wins, for server and client alike. `workerd` and `worker` never match (inferred). For example, `react-dom/server` lists `workerd` first and `node` before `browser`, so a Worker importing it would get `server.node.js` ([react-dom package.json][react-dom-pkg]) (inferred). `react-dom/client` has only `react-server` and `default`, so client bundles are unaffected.
- **The `conditions` option does nothing for npm imports.** It is passed to `esbuild.build`, but the plugin calls `resolveModule` without it ([bundler.ts L135, L243][wb-plugin]). The only test covers the `bundle: false` warning (inferred from the code).
- **No `browser` field.** The fallback reads `module` then `main` only ([resolver.ts L160-170][wb-resolver-pkg]).
- **Unresolved means external, silently.** Anything the plugin can't resolve is marked external with no warning ([bundler.ts L143-155][wb-plugin]). Open issue [#2577][issue-2577] (2026-10-13): `imports` (`#subpath`) and an extensionless `main` both end as "No such module" when the Worker starts, and "The build reports no warning". `chalk@5`, `xml2js`, `form-data` and `pug` are named. A tsconfig alias such as `@/components/button` goes the same way, because `@/components` parses as a scoped package name (inferred).

#### 1.6 Handing it packages we've already downloaded

- **Yes.** Put them in the `FileSystem` under `node_modules/<name>/`. The installer skips any package whose `node_modules/<name>/package.json` exists, and "Transitive deps are assumed to also be present" ([installer.ts L144-153][wb-installer-skip]). Two e2e tests cover the skip ([e2e.test.ts L798-830][wb-e2e-skip]). If every direct dependency is present, no network call happens (inferred). It doesn't compare versions, so keeping `node_modules` in step with `package.json` is our job (inferred).
- **The interface is synchronous and text-only.** `read(path): string | null`, `write`, `delete`, `list(prefix?)` and `flush()` ([file-system.ts L1-38][wb-fs]). It is synchronous "because esbuild and TypeScript require synchronous file access" ([README L712-714][wb-readme-snap]).
- **It can read DO SQLite directly.** The package's own `DurableObjectRawFileSystem` does a synchronous `ctx.storage.kv.get` on every `read` ([file-system.ts L161-205][wb-fs-do]). A `FileSystem` over our package table using `ctx.storage.sql.exec` would read one row per file esbuild touches, rather than loading all of `node_modules` first (inferred).
- **Our tree must be flattened.** One version per name fits the resolver. Where two versions are really needed, a plugin passed through `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired` runs before the internal resolver and could do nested resolution ([README L613-645][wb-readme-plugins]). That option "is not covered by semver".
- **`@cloudflare/shell`'s `Workspace` is async.** It needs `createFileSystemSnapshot`, which copies everything into an `InMemoryFileSystem` ([README L712-729][wb-readme-snap], [file-system.ts L275-287][wb-fs-snap]).

#### 1.7 What its installer does and caches

- **What it installs.** `dependencies` only. `devDependencies` need `dev: true`, which `createWorker` and `createApp` never pass ([installer.ts L92-96][wb-installer], [index.ts L117-124][wb-index]). Peer and optional dependencies are never read (inferred from the code).
- **Requests.** Per package: the abbreviated packument (`application/vnd.npm.install-v1+json`), then the tarball. That is 2 subrequests per package ([installer.ts L229-322][wb-installer-fetch]). Timeouts are 30 s for metadata and 60 s for tarballs ([common.ts L5][wb-common], [installer.ts L305-310][wb-installer-fetch]).
- **Versions.** `latest` or `*`, then an exact match, then a dist-tag, then `semver.maxSatisfying`. No lockfile ([installer.ts L265-289][wb-installer-fetch]).
- **Fan-out.** Recursive `Promise.all` with no depth or concurrency limit ([installer.ts L107-120, L195-209][wb-installer], [README L874][wb-readme-lim]). The first version installed for a name wins ([installer.ts L139-142][wb-installer]), so conflicting ranges resolve by timing (inferred).
- **No integrity check.** `dist.integrity` is declared in a type and never read ([installer.ts L28-32][wb-installer]).
- **Extraction.** The whole tarball is buffered, gunzipped with `DecompressionStream`, and parsed by an in-house tar reader that keeps only text extensions ([installer.ts L294-443][wb-installer-fetch], [common.ts L23-71][wb-common]). PAX headers aren't handled ([README L872][wb-readme-lim]).
- **Caching.** None of its own. It writes into the `FileSystem` you pass. With `DurableObjectKVFileSystem` and `flush()`, `node_modules` persists in DO KV under a `bundle/` prefix and the next call skips installing ([README L688-702][wb-readme-fs]). Otherwise every `createWorker` or `createApp` call installs again.

#### 1.8 esbuild-wasm: size, start-up, memory and CPU

- **Size.** `esbuild.wasm` 0.28.1 is 13,940,120 bytes, shipped again in worker-bundler's `dist/` (measured, [esbuild-wasm listing][esb-list], [worker-bundler listing][wb-list]). The module declares 95 pages (5.9 MiB) of initial linear memory and no maximum. Its code section is 9.99 MB and its data section 3.93 MB (measured by reading the section headers of the [downloaded file][esb-wasm]; not run).
- **How it loads.** It imports `esbuild-wasm/lib/browser.js`, because "the default "main" entry rejects wasmModule in Workers with nodejs_compat" ([bundler.ts L5-7][wb-bundler-import]). It starts `import("./esbuild.wasm")` when its own module is evaluated, in workerd only, so the compile overlaps other work ([bundler.ts L370-393][wb-bundler-init]). The first build calls `initialize({ wasmModule, worker: false })` ([bundler.ts L395-451][wb-bundler-init]).
- **Start-up time.** No figure is published. A source comment says the first call "paid the full wasm-compile cost serially, which was enough to flake the first test … under vitest's default 5s timeout on slower CI runners" ([bundler.ts L370-380][wb-bundler-init]). Its tests run with 30 s timeouts and 3 retries ([vitest.config.ts][wb-vitest]). Expect up to seconds on a cold isolate (inferred).
- **Speed.** esbuild's docs say the Wasm build is "much, much slower… In many cases it is an order of magnitude (i.e. 10x) slower" (see [deps-vfs-editor.md](./deps-vfs-editor.md) §5).
- **Memory.** No figure for a small app. esbuild's author: "The WebAssembly output is not optimal in terms of memory usage, code size, or performance" ([esbuild#2503][esb-2503]), and "Go is not the right language to use if your goal is a high-performance low-memory WebAssembly module" ([esbuild#1298][esb-1298]). In that 2021 report, `export * from "typescript"` and `@babel/core` each took "over 500 Mb of ram" in a browser.
- **Lifetime.** One esbuild instance per isolate. Initialisation state lives in module globals ([bundler.ts L338-340][wb-bundler-init]). esbuild's `stop()` in `worker: false` mode drops its references to the Go instance ([browser.js L1915-1918, L2665-2670][esb-browser]), which would let V8 collect it (inferred). worker-bundler never calls `stop()`, doesn't export it, and can't re-initialise. So after the first build, esbuild's linear memory stays until the isolate goes away (inferred).
- **CPU.** It counts against the calling request: 30 s by default, up to 5 min with `limits.cpu_ms` ([cloudflare-platform.md](./cloudflare-platform.md) §1).

#### 1.9 Known issues

- **Documented limits** ([README L869-876][wb-readme-lim]): flat `node_modules`, no PAX headers, text files only, no recursion depth limit, and the TypeScript tarball download (only relevant to its `./typescript` subpath, which we don't need).
- **Open:** [#2577][issue-2577], silent externals for `imports` and extensionless `main` (above).
- **Recently fixed:** subpath imports without `exports` resolved to the root ([#2466][issue-2466], fixed in 0.2.6). DefinitelyTyped tarballs written one directory too deep ([#2008][issue-2008], fixed in 0.2.3). ReDoS in import scanning ([#1537][issue-1537], fixed in 0.2.2). Cryptic `gojs` error under Node ([#1306][issue-1306], fixed in 0.1.2).
- **Found by reading the code, with no upstream issue I could find:** CSS imported from JS is dropped, `.module.css` is treated as global CSS, `tsconfig.json` is ignored, `conditions` doesn't reach npm resolution, `createApp` has no `virtualModules`, and tarball integrity isn't checked.

### 2. CSS tooling

Tailwind is read at tag v4.3.3 ([`c2b24dd`][tw-sha]), released 2026-07-15. Sizes marked "measured" come from jsDelivr listings or from reading Wasm import sections, never from running the code.

#### 2.1 Tailwind CSS v4: the compiler runs, the scanner doesn't

- **The compiler is pure JS.** `tailwindcss` 4.3.3 has no runtime dependencies ([npm][tw-npm]). Its `src` has no `node:`, `fs` or `path` imports. The published `lib.mjs` and its two chunks (about 263 KB) contain no `eval`, `new Function`, `WebAssembly`, `Worker` or `process.` (measured, [listing][tw-list]).
- **The API.** `compile(css, { base, from, loadStylesheet, loadModule })` returns an object whose `build(candidates)` returns CSS ([index.ts L55-85, L820-856][tw-compile]). Unknown candidates are skipped, so an extractor that collects too much is harmless (inferred from [index.ts L726-787][tw-invalid]).
- **Scanning is the caller's job.** `compile()` only returns the `@source` globs. `@tailwindcss/vite` creates Oxide's `Scanner` and calls `scan()` itself ([vite index.ts L11, L595, L621][tw-vite-scan]).
- **It's an internal API.** Adam Wathan, February 2025: "You can probably just use `tailwindcss` or maybe `@tailwindcss/node`… if you are willing to mess around with the internal/undocumented/not public APIs we use for everything" ([discussion #16581][tw-16581]).
- **Someone ships this in production.** `@react-email/tailwind` 2.0.7 depends only on `tailwindcss`. It calls `compile(baseCss, { loadModule, loadStylesheet })` and then `build(candidates)` ([dist/index.mjs][react-email]).
- **What `loadStylesheet` must serve.**
  - The published `index.css` (29,786 bytes) already has its imports inlined, "so that we don't need to handle imports at runtime" ([pre-publish-optimizations.mjs L7-8][tw-inline]). So `@import "tailwindcss"` needs just that one file.
  - Split imports need `theme.css`, `preflight.css` and `utilities.css`. `@tailwindcss/browser` has the ID mapping to copy ([browser index.ts L109-160][tw-browser-ids]).
  - The project's own `@import "./x.css"` also goes through `loadStylesheet` ([at-import.ts L39-58][tw-atimport]).
- **Plugins.** `@plugin` and `@config` need `loadModule` to return a JS module. With no `eval` in workerd, any plugin (typography, forms) must be bundled into our builder in advance (inferred). The browser build simply throws "The browser build does not support plugins or config files" ([browser index.ts L174][tw-browser-ids]).
- **Lightning CSS isn't needed for valid output.** The 4.3.3 changelog says "Ensure CSS nesting is handled even when Lightning CSS isn't run, such as in `@tailwindcss/browser` and Tailwind Play" ([CHANGELOG L23][tw-cl]). What we'd lose is `@tailwindcss/node`'s optimise step, which runs Lightning CSS against browser targets ([optimize.ts L29-55][tw-optimize]). `@tailwindcss/node` itself needs `node:fs`, `jiti`, `enhanced-resolve` and native Lightning CSS, so it won't run in workerd ([compile.ts L1-6][tw-node]).
- **Oxide's scanner needs threads.** It uses rayon's `par_iter()` ([scanner/mod.rs L19, L256][tw-rayon]).
- **`@tailwindcss/oxide-wasm32-wasi` 4.3.3 can't load in workerd.**
  - Its browser loader fetches the Wasm by URL and creates `new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true })`, which is 1 GiB initial. It sets `asyncWorkPoolSize: 4` and calls `new Worker(...)` ([loader][tw-oxide-wasi]).
  - The Wasm imports `wasi.thread-spawn` and a shared memory (measured). The Node loader needs `node:wasi` and `node:worker_threads`.
  - It was built for StackBlitz ([PR #17558][tw-17558]). A threadless Oxide exists only as an unmerged PR ([#18292][tw-18292]).
- **`@tailwindcss/browser`** is a 282 KB IIFE (measured). It compiles `<style type="text/tailwindcss">` with `compile()` and collects candidates from `document.querySelectorAll('[class]')`, with no scanner at all ([browser index.ts][tw-browser-ids]). Tailwind says the Play CDN "is designed for development purposes only, and is not intended for production" ([docs][tw-play]). It touches `document` at the top level, so it can't be imported in workerd as it is. Its approach can be copied (inferred).
- **No JS scanner exists in the Tailwind repo.** Even `@tailwindcss/upgrade` imports Oxide (inferred from a search of `packages/`). Two substitutes:
  - A regex tokenizer, like UnoCSS's default extractor, which splits on whitespace, quotes, backticks, semicolons and braces ([`@unocss/core`][uno-core]).
  - `@raybase/vaportrail` 0.2.0. It wraps Oxide's single-threaded `Extractor`, not the rayon `Scanner`, for `wasm32-unknown-unknown`. A `workerd` export imports the 1.44 MB Wasm statically. It uses its own non-shared memory and imports only 2 functions (measured). It warns "Large CSS entries or large candidate sets can exceed normal Worker CPU budgets". The repo has 2 commits, the latest on 2026-06-29 ([README][vaportrail], [lib.rs][vaportrail-lib]).
- **Earlier precedent.** A Tailwind v3 Worker ran PostCSS, Tailwind 3 and autoprefixer by stubbing `fast-glob` and `jiti` and patching `fs` calls ([aiji42/cloudflare-workers-tailwind][aiji42]). Tailwind issues #15399 and #15519 are Pages build-machine failures, not workerd.

#### 2.2 PostCSS

- `postcss` 8.5.30 depends on `nanoid`, `picocolors` and `source-map-js`, all pure JS ([npm][postcss-npm]).
- It requires `path` and `url` for source maps, and `fs` only to load a previous source map from disk ([previous-map.js L110-112][postcss-prevmap]). Its `browser` field maps `fs`, `url`, `path` and `source-map-js` to `false`.
- It checks `if (Buffer)` without `typeof`, which throws when there is no global `Buffer` ([previous-map.js L18][postcss-prevmap]). `nodejs_compat` provides one. It is on by default for compatibility dates from 2026-08-04 ([changelog][cf-njs-default]).
- Tailwind v4's compiler doesn't need PostCSS at all.

#### 2.3 Lightning CSS (`lightningcss-wasm` 1.33.0)

- **Size.** `lightningcss_node.wasm` is 15,844,785 bytes (measured), bigger than esbuild's.
- **Loading.** `init()` defaults to fetching the Wasm by URL. Any other argument is awaited and, if it isn't a `Response`, passed to `WebAssembly.instantiate(module, imports)` ([wasm/index.mjs L13-19, L105][lcss-init]). So `init(Promise.resolve(precompiledModule))` should work (inferred). The `node` export condition reads the file and calls `new WebAssembly.Module(bytes)`, which workerd blocks, so the bundler must not pick it (inferred).
- **No threads.** Its imports are napi functions only, with no WASI and its own non-shared memory (measured). It uses Asyncify to "call async JavaScript functions without multi-threading" ([async.mjs L13][lcss-async]).
- **Bundling.** `bundle` and `bundleAsync` take a custom `resolver { read, resolve }` ([index.d.ts L255-270][lcss-dts]). The docs in the source say these "are also available in the WASM build", though the live website still says they aren't ([docs.md L83][lcss-docs]).
- **CSS modules.** `cssModules: boolean | CSSModulesConfig` covers "a subset of CSS modules features" ([index.d.ts L35][lcss-dts]).

#### 2.4 UnoCSS

- `@unocss/core` 66.11.0 has no dependencies, no imports and no `eval`. Its `dist/index.mjs` is 49,255 bytes (measured). `createGenerator` is async ([npm][uno-core]).
- `@unocss/preset-wind4` (222,608 bytes, measured) is "The Tailwind4 CSS compact preset for UnoCSS" ([docs][uno-wind4]). It is configured in `uno.config.ts`, and its docs never mention `@theme`, `@utility` or `@custom-variant`. So it would ignore a Tailwind v4 CSS-first config. It imitates Tailwind rather than running it (inferred).
- `@unocss/runtime` generates styles in the browser from DOM changes, with a warning about a flash of unstyled content ([docs][uno-runtime]).
- I found no first-party statement about Workers.

#### 2.5 What vibesdk and Cloudflare OS do for styling

- **vibesdk:** plain `.css` files shipped as assets. "No CSS preprocessors at runtime" (§4.1).
- **Cloudflare OS:** a `<style>` element injected from the gadget's JavaScript, under a CSP that blocks CDNs (§4.3).
- Neither compiles Tailwind inside an isolate.

### 3. Vite and Rolldown

- **Vite 8 can't run in workerd.**
  - `vite` 8.3.4 is the latest. Vite 8 "ships with Rolldown as its single, unified, Rust-based bundler" and "requires Node.js 20.19+, 22.12+" ([Vite 8 announcement][vite8]).
  - Its dependencies include `rolldown` and native `lightningcss` ([npm][vite-npm]).
  - It has no browser build. Its main chunk imports `node:worker_threads`, `node:child_process`, `node:http`, `node:net`, `node:fs` and more (measured).
  - Only `vite/module-runner` is runtime-agnostic, and it runs modules rather than building them.
- **No maintained "Vite without Node".** `divriots/browser-vite`, a Vite 2.7 fork, was archived after its last commit in March 2022 ([repo][browser-vite]). StackBlitz runs real Vite on Node inside WebContainers in the browser (§4.4).
- **Rolldown can't run in workerd.**
  - `@rolldown/browser` is still 1.2.13. Its loader still fetches the Wasm by URL, allocates shared memory and calls `new Worker`, as [deps-vfs-editor.md](./deps-vfs-editor.md) §5 found.
  - The only Wasm target is `wasm32-wasip1-threads` ([package.json scripts][rolldown-pkg], [getting started L58-75][rolldown-docs]). I found no documented single-thread mode and no way to pass a precompiled module.
  - `@rolldown/binding-wasm32-wasi` 1.2.13 has the same shared-memory loader (measured).
- **Confirmed: building in the platform means not using the project's Vite config.** Its plugins (React, Tailwind, Cloudflare) need Node. The platform has to reproduce what the config does:
  - JSX through esbuild's `jsx: "automatic"`.
  - Tailwind through a separate `compile()` step.
  - Wrangler config, which worker-bundler already reads.
- **`@cloudflare/vite-plugin` only matters off the platform.** Version 1.63.2 depends on `wrangler`, `miniflare` and the native `workerd` binary ([npm][cf-vite-npm]). Cloudflare says "When you use the Cloudflare Vite plugin, Vite 8 bundles your code using Rolldown" rather than esbuild ([blog, 2026-09-09][cf-vite-blog]). So an exported project built locally with Vite uses a different bundler from the platform's esbuild-wasm, and the output can differ (inferred).

### 4. Prior art

Read at cloudflare/vibesdk [`9da158d`][vibe-sha] (still `main` on 2026-10-13), cloudflare/vibesdk-templates [`7ea201f`][vtpl-sha] (2026-05-13) and cloudflare/cloudflare-os [`8001c4b`][cfos-sha2] (2026-10-13).

#### 4.1 vibesdk: it doesn't build React front-ends

- **Correction to [cloudflare-platform.md](./cloudflare-platform.md) §5.** That note said vibesdk's build "only bundles with esbuild-wasm and sucrase". Sucrase is a dependency of worker-bundler, used only when `bundle: false` (§1.1). vibesdk never sets `bundle`, so its path is esbuild-wasm alone (inferred from the defaults).
- **Why worker-bundler has sucrase at all.** Its transformer comment says sucrase is "~20x faster than Babel" and "Works in any JS environment (no WASM needed)" ([transformer.ts L43-L55][wb-transformer]). Transform-only mode also never touches esbuild, so it runs under Node ([CHANGELOG L133][wb-cl-133]).
- **Server only.** `SpaceDO` calls `createApp({ files, assets, assetConfig, server })` with no `client` ([deploy-engine.ts L197-204][vibe-createapp]). Browser files are copied as they are.
- **The agent is told not to write JSX for the browser.** Its skill says "The browser eventually runs your assets — the bundler does **not** transform them" and "NEVER ship JSX in a `<script type="module">`" ([SKILL.md L233-237][vibe-skill-assets]). The workarounds it offers are hand-written `React.createElement` or `@babel/standalone` plus an esm.sh import map in the page ([SKILL.md L248-274][vibe-skill-react]). It warns about a "dual-React trap" with esm.sh and says to stop using import maps beyond two or three React packages ([SKILL.md L309-355][vibe-skill-dual]).
- **Styling.** "No CSS preprocessors at runtime — ship `.css`, not `.scss`" ([SKILL.md L306][vibe-skill-css]). Nothing compiles Tailwind anywhere in `worker/` or `space/`, though design skills still show `tailwind.config` snippets the pipeline can't use (inferred).
- **Binaries.** "Binary assets are not extracted from npm packages… Put binaries directly in `public/`" ([SKILL.md L303][vibe-skill-bin]). But files are read as strings before bundling, so binary files in `public/` may not survive (inferred, untested) ([deploy-engine.ts L58-94][vibe-read]).
- **HTML.** `index.html` is a hand-written asset. SpaceDO rewrites root-relative `src`, `href` and `action` with `HTMLRewriter`, but "JS-side fetches and dynamic imports are NOT rewritten" ([SKILL.md L16][vibe-skill-html]).
- **Builds are stored, not repeated.** Each build's modules and assets are saved as JSON in a `deployments` SQLite table and loaded with `LOADER.get(<space>-<branch>-<commit>)`, so a cold start doesn't rebuild ([deploy-engine.ts L129-141][vibe-deployments], [durable-object.ts L741-757][vibe-loader]).
- **Limits.** Still on worker-bundler 0.0.4 with esbuild-wasm 0.27.4 ([space/package.json L30][vibe-space-pkg], [bun.lock L334][vibe-lock]). No `limits.cpu_ms` in its wrangler configs, so builds run on the 30 s default (inferred).

#### 4.2 vibesdk templates

- **Where.** A separate repo, `cloudflare/vibesdk-templates`, packed into an R2 bucket at deploy ([wrangler.jsonc L218][vibe-tpl-var], [deploy.ts L582-690][vibe-tpl-deploy]).
- **The React reference.** React 18.3, Vite ^6.3.1, `@cloudflare/vite-plugin` 1.17.1, Tailwind ^3.4.17 through PostCSS and autoprefixer, TypeScript 5.8, Hono ^4.9.8, about 25 Radix packages and framer-motion ([package.json L14-101][vtpl-pkg]). shadcn/ui ("new-york", 46 components) ([components.json][vtpl-shadcn]). `tsconfig.app.json` sets `"jsx": "react-jsx"` ([L16-19][vtpl-tsconfig]). `vite.config.ts` opens with "Making changes to this file is **STRICTLY** forbidden" ([L1][vtpl-vite]).
- **Not adapted for in-Worker builds.** They only run on the retired container path, which runs `bun install` and `bun run build` ([sandboxSdkClient.ts L940, L1757][vibe-bun]). The Think path "bypasses VibeSDK's template catalog entirely" ([controller.ts L202-212][vibe-bypass]). The closest no-build template is `minimal-js`, vanilla HTML, CSS and JS ([minimal-js.yaml][vtpl-minjs]).

#### 4.3 Cloudflare OS: no build at run time

- **Gadgets load as written.** `loadGadgetWorker` keeps committed files ending in `.js` and loads them with `mainModule: "server.js"` ([overseer.ts L4318-4381][cfos-load]). No worker-bundler, esbuild-wasm or sucrase at run time.
- **UI is one hand-written `client.js`.** "TODO: Bundle the UI? For now we just return client.js." ([overseer.ts L4564-4569][cfos-todo]). The agent is told "there is no index.html. Instead, client.js must build the entire UI using JavaScript code" ([agent.ts L635-660][cfos-prompt]).
- **Styling.** The gadget iframe's CSP is `script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; connect-src 'none'` ([GadgetUI.tsx L105-115][cfos-csp]). So no CDNs, import maps or Tailwind CDN. Styles are a `<style>` element injected from JS ([client.ts L74][cfos-style]).
- **Its own TypeScript and React are built ahead of time with native esbuild and Vite.** Bundled blueprints compile at platform build time, and "`import "./styles.css"` fails the build" ([bundled-blueprints README L57-80][cfos-blueprints]). The management UI is "a single-file React SPA… (Vite + Tailwind + Kumo) bundled by `build-app.ts`" ([AGENTS.md L35][cfos-agentsmd]).

#### 4.4 Others

- **Cloudflare's examples bundle servers, not React.** `worker-bundler-playground` calls `createApp` with no `client` ([server.ts L167-174][ex-wbp-server]). The bundler's own tests say "We don't have React in the test fixtures" ([e2e.test.ts L526][wb-e2e-react]).
- **`@hono/esbuild-transpiler`** transpiles `.ts`/`.tsx` per request in Workers with esbuild-wasm (`wasmModule`, `worker: false`), one file at a time, no bundling ([README][hono-esb], [wasm.ts L16-31][hono-esb-wasm]).
- **`@raybase/vaportrail`** claims "Worker-compatible runtime Tailwind scanning and compilation": a Wasm build of Tailwind v4's extractor plus `compile().build(candidates)`. It warns "Large CSS entries or large candidate sets can exceed normal Worker CPU budgets" ([README L3-51][vaportrail]). It is small and young (see §2).
- **bundlejs** runs esbuild-wasm in production on Deno Deploy, not Workers, and claims Wasm esbuild is "roughly 2–5× slower than native Go", without a benchmark ([architecture.md][bundlejs]).
- **Everyone else builds outside an isolate.** StackBlitz and bolt.new run Node in the browser tab ([WebContainers][webcontainers]). Lovable runs a Vite dev server per preview in sandboxes and is moving to a Rust, Rolldown and Oxc binary ([blog, 2026-09-15][lovable]). v0 runs each chat in Vercel Sandbox, "a lightweight virtual machine" ([docs][v0]). esm.sh is a Go server on native esbuild, with Cloudflare only as its CDN ([go.mod L9][esmsh-gomod], [HOSTING.md][esmsh-hosting]).
- **No source publishes esbuild-wasm build time, memory or CPU inside workerd.** The self-modifying harness RFC avoids rebuilding every turn because that "pays esbuild cost when no source changed" ([rfc L363-367][rfc-smh-cost]).

### 5. Memory: esbuild-wasm and ts-rust in one isolate

- **The budget.** 128 MB per isolate, "including the JavaScript heap and WebAssembly allocations". DOs of one class may share an isolate and its 128 MB ([cloudflare-platform.md](./cloudflare-platform.md) §1).
- **ts-rust.** It reserves a 32 MiB shadow stack in linear memory and publishes no absolute memory figures. Each Check is a fresh instance of the compiled module ([ts-rust.md](./ts-rust.md) §2).
- **esbuild-wasm.** It starts at 5.9 MiB of linear memory and grows on demand with no declared maximum. No source gives a figure for a small React app, and its author says the Wasm build is not optimal for memory (§1.8).
- **Tailwind's compiler** is about 263 KB of plain JS, so its cost is ordinary JS heap. Lightning CSS would add a 15.8 MB Wasm module, so leave it out (§2).
- **Compiled code.** V8 must also compile about 10 MB of esbuild Wasm code and 4.2 MB of ts-rust. workerd compiles Wasm with V8's fast baseline tier first and optimises in a background thread, because "Otherwise Wasm startup is way too slow" ([worker-modules.h L307-324][wd-wasm]). Cloudflare doesn't say whether compiled code counts toward the 128 MB ([Workers WebAssembly][cf-wasm]).
- **Can they share? Plausibly for small projects, with little headroom (inferred).** A Turn already holds Think's JS heap, the chat history and file contents. A Check adds ts-rust's 32 MiB stack plus its heap. A build adds esbuild's Go heap, which then stays (below). Nobody has published numbers for either Wasm module in workerd, so this needs measuring, not estimating.
- **Loading only when needed.**
  - ts-rust is instantiated per run, so its linear memory becomes garbage when a Check returns (inferred from [ts-rust.md](./ts-rust.md) §2).
  - worker-bundler starts loading `esbuild.wasm` as soon as its own module is evaluated (§1.8). Importing worker-bundler with a dynamic `import()` on the first build should defer that (inferred). A workerd comment says its compile helper "also runs lazily (e.g. for modules served by the fallback service)", which suggests Wasm modules in a deployed script are normally compiled when the script loads ([worker-modules.h L310-314][wd-wasm]) (inferred).
- **Releasing afterwards.**
  - WebAssembly memory can grow but not shrink ([WebAssembly/design#1397][wasm-shrink], open).
  - esbuild's own `stop()` would drop the instance. worker-bundler doesn't call or expose it, and keeps its "initialised" flag in a module global. So the only release is the isolate going away (§1.8, inferred). Changing that means forking worker-bundler or driving esbuild-wasm ourselves.
- **Moving the build out of the Workspace's isolate (inferred).** Two ways, both still Workers only:
  - A separate builder Worker over a service binding. RPC payloads are capped: "The maximum serialized RPC limit is 32 MiB", with streams for anything larger ([Workers RPC][cf-rpc]). It would need a copy of the source plus the `node_modules` files the build reads. React 19.3's `react-dom` alone is 8.06 MB unpacked across 43 files (measured, [npm][npm-react-dom]).
  - A Dynamic Worker carrying worker-bundler plus `esbuild.wasm` as a `{wasm: ArrayBuffer}` module ([Dynamic Workers API][dw-api]). workerd can reuse Wasm code another isolate already compiled ([worker-modules.h L78-89][wd-wasm-share]). Whether that applies to Worker Loader modules is undocumented.
  - The trade-off: inside the DO, a `FileSystem` can read SQLite lazily (§1.6). Elsewhere, files have to be copied across first.

### 6. Tests inside isolates

From a separate research thread. Read at vitest [v5.0.4 `6a11cf6`](https://github.com/vitest-dev/vitest/tree/6a11cf66f99fa610b7364363d5ca42b66d994f40) (2026-10-12), cloudflare/workers-sdk [`d6b1c82`](https://github.com/cloudflare/workers-sdk/tree/d6b1c823268226754441ac79084be2cec4abcea3), workerd [`3371391`][wd-sha] and cloudflare/agents [`b1e3614`][agents-sha].

#### 6.1 Real vitest can't run in an isolate

- **Node is required.** `vitest` 5.0.4 needs Node `^22.12.0 || ^24.0.0 || >=26.0.0`, with `vite` as a required peer ([package.json](https://cdn.jsdelivr.net/npm/vitest@5.0.4/package.json)).
- **The worker side is Node code.** `vitest/dist/worker.js` imports `node:async_hooks`, `fs`, `module`, `vm` and more. It runs test files through Vite's module runner ([worker.js](https://cdn.jsdelivr.net/npm/vitest@5.0.4/dist/worker.js)), which evaluates code with `new AsyncFunction(...)` ([module-runner.js L23, L825](https://cdn.jsdelivr.net/npm/vite@8.3.4/dist/node/module-runner.js)). Workers block that.
- **The public entry can't stand alone.** `expect`, `vi` and snapshots call `getWorkerState()`. That throws "Vitest failed to access its internal state" unless a pool has set it up ([utils chunk](https://cdn.jsdelivr.net/npm/vitest@5.0.4/dist/chunks/utils.DYj33du9.js)). So we can't alias the real package into a Dynamic Worker (inferred).
- **Browser mode needs a Vite server** and a provider (`preview`, `playwright` or `webdriverio`) ([migration guide](https://github.com/vitest-dev/vitest/blob/6a11cf66f99fa610b7364363d5ca42b66d994f40/docs/guide/migration/index.md)).

#### 6.2 Cloudflare's vitest integration needs Node too

- **Renamed.** `@cloudflare/vitest-pool-workers` stopped at 0.23.0 and "has been renamed to @cloudflare/vitest-plugin" ([npm](https://registry.npmjs.org/@cloudflare/vitest-pool-workers)). The current package is `@cloudflare/vitest-plugin` 1.4.1.
- **Three contexts.** Its pool "Runs in Node.js Vitest process" and starts `workerd` processes. Only the tests run inside workerd ([AGENTS.md](https://github.com/cloudflare/workers-sdk/blob/d6b1c823268226754441ac79084be2cec4abcea3/packages/vitest-plugin/AGENTS.md), [docs](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/)).
- **Local-only bindings.** Inside workerd it relies on "unsafe-eval bindings" and a "module-fallback service" that sends unresolved imports to Node-side Vite ([blog](https://blog.cloudflare.com/workers-vitest-integration/), [pool/index.ts L452-454, L677](https://github.com/cloudflare/workers-sdk/blob/d6b1c823268226754441ac79084be2cec4abcea3/packages/vitest-plugin/src/pool/index.ts#L452-L454)). Neither can be set in a Worker Loader `WorkerCode` ([API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)) (inferred).

#### 6.3 What workerd provides

- **`node:test` is mocks only.** It exports `mock`, `MockFunctionContext` and `MockTracker`, with no `test`, `describe` or `it`. It "currently does not include an implementation of the Node.js mock timers API" ([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/test/), [test.ts](https://github.com/cloudflare/workerd/blob/3371391b377a6b8e15bb5fe879a4640f44962032/src/node/test.ts)).
- **`node:assert` works**, in strict mode ([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/assert/)).

#### 6.4 The parts that do run

| Package | Size | Runs in workerd? |
| --- | --- | --- |
| `@vitest/runner` 4.1.11 | 194 KB | Yes. No `node:` imports. Deprecated in v5: security fixes only, and the runner moved inside `vitest` ([migration guide](https://github.com/vitest-dev/vitest/blob/6a11cf66f99fa610b7364363d5ca42b66d994f40/docs/guide/migration/index.md#L623-L630)) |
| `@vitest/expect` 5.0.4 + `chai` 6.3.0 | 108 KB + 150 KB | Yes. But since v5 it "no longer shares state with Vitest's `expect`" (same page) |
| `@vitest/spy` 5.0.4 | 42 KB | Yes. No dependencies |
| `@sinonjs/fake-timers` 15.4.0 | | Yes, through its `browser` field. vitest's fake timers are built on it |
| `@vitest/snapshot` 5.0.4 | 62 KB | No. It parses snapshot files with `new Function`, which Workers block |
| `@std/expect` (JSR) 1.0.20 | | Yes (`"workerd": true`). worker-bundler takes one registry, so JSR packages would need vendoring (inferred) |
| zora 6.0.4 | | Risky. It calls `setTimeout` at module top level, which workerd forbids outside a request |
| uvu, tape, tap, Jest's `expect` | | No or stale. They need Node or haven't been updated since 2022 |

#### 6.5 A runner we could build

These steps are (inferred) from the pieces above.

- **Bundle.** Generate a test entry that maps each `*.test.ts` to a lazy `import()`. Without code splitting, esbuild turns those into in-bundle requires ([esbuild](https://esbuild.github.io/api/#splitting)). Test files then evaluate inside the handler, which avoids workerd's ban on timers and randomness at global scope.
- **Alias `vitest`.** Use `createWorker`'s `virtualModules` to point `vitest` at our shim. `createApp` doesn't pass `virtualModules` (§1.2), so test bundles use `createWorker`.
- **Run.** Load the bundle in a Dynamic Worker that exposes a `WorkerEntrypoint` method returning JSON results. `@cloudflare/codemode` already uses this pattern ([executor.ts L414-497](https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/codemode/src/executor.ts#L414-L497)).
- **Supported:** `describe`, `it`, hooks, `each`, `only`, `skip`, `expect` matchers, `vi.fn`, `vi.spyOn` and fake timers.
- **Not supported:**
  - `vi.mock` and `vi.hoisted`, which rely on static analysis and loader hooks ([vi.md L38-45](https://github.com/vitest-dev/vitest/blob/6a11cf66f99fa610b7364363d5ca42b66d994f40/docs/api/vi.md#L38-L45)).
  - File and inline snapshots.
  - Coverage.
  - Accurate durations.

#### 6.6 Per Template

- **Hono Worker: fully testable.** `app.request(path, init, env, executionCtx)` builds a `Request` and calls `fetch`, with no runtime-specific imports ([hono-base.js L321-325](https://cdn.jsdelivr.net/npm/hono@4.13.13/dist/hono-base.js)). A small `cloudflare:test` shim covers `env`, `SELF` and `createExecutionContext` (inferred from [events.ts](https://github.com/cloudflare/workers-sdk/blob/d6b1c823268226754441ac79084be2cec4abcea3/packages/vitest-plugin/src/worker/events.ts)).
- **React: logic and rendered HTML only.**
  - `react-dom/server` resolves to its edge build in workerd, so render-and-assert tests work ([react-dom package.json](https://cdn.jsdelivr.net/npm/react-dom@19.3.0/package.json)).
  - jsdom and happy-dom both call `vm.runInContext` when they create a window, and workerd throws `ERR_METHOD_NOT_IMPLEMENTED` for it ([vm.ts L110-134](https://github.com/cloudflare/workerd/blob/3371391b377a6b8e15bb5fe879a4640f44962032/src/node/vm.ts#L110-L134)). So `@testing-library/react` component tests can't run.
  - A real DOM would need Browser Run, which Q38 left out.

#### 6.7 workerd constraints on a runner

- **Time stands still during CPU work.** "`Date.now()` returns the time of the last I/O" ([security model](https://developers.cloudflare.com/workers/reference/security-model/)). Durations read about 0 ms, and a timeout can't interrupt a synchronous loop.
- **No timers or randomness at global scope** ([io-context.c++ L1656-1661](https://github.com/cloudflare/workerd/blob/3371391b377a6b8e15bb5fe879a4640f44962032/src/workerd/io/io-context.c%2B%2B#L1656-L1661)).
- **Hitting the CPU limit kills the whole invocation**, and every result in it is lost ([custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)). So run one test file per invocation, or stream results out (inferred).

#### 6.8 Risks

- The best runner package is deprecated, and `@vitest/expect` no longer tracks vitest's own `expect`.
- Matching vitest's behaviour is on us. The Agent may write tests that pass in our runner and fail in real vitest, or the other way round.

### 7. Recommendation for the two Templates

This section is my synthesis of §1 to §5, so all of it is (inferred). Testing is left to §6.

#### 7.1 One build path for both

- **Bundler.** `@cloudflare/worker-bundler`, pinned to an exact version and wrapped in our own `build()` function, so a fork or a switch later touches one file.
- **Input.** A synchronous `FileSystem` that reads the Workspace's files and our package store from DO SQLite, and presents packages flat at `node_modules/<name>/`. Every direct dependency is already there, so its installer never fetches anything (§1.6).
- **After every build.** Fail the build if the output still imports a bare specifier other than `cloudflare:*` and `node:*`. That turns worker-bundler's silent externals into errors the Agent can see (§1.5).
- **Caching.** Hash the inputs, store the output in SQLite, and use the hash as the `LOADER.get` ID, as vibesdk does with commits (§4.1).
- **Where it runs.** Start inside the Workspace DO with a lazy `import()` of worker-bundler, and measure peak memory with a Check running too. Keep the build behind an interface so it can move to a builder Worker or Dynamic Worker if the numbers are tight (§5).
- **CPU.** Set `limits.cpu_ms` to 300,000. Neither vibesdk nor Cloudflare's examples do, and a Turn may run several builds and Checks inside one event's budget.
- **Wrangler config.** List `nodejs_compat` explicitly in each Template. worker-bundler looks for the literal flag ([config.ts L180-181][wb-config]), even though compatibility dates from 2026-08-04 turn it on by default (§2.2).

#### 7.2 The Hono Worker Template

- `src/index.ts` exporting the Hono app, plus `wrangler.jsonc`. `createWorker` already handles exactly this shape, and it is the one path vibesdk, the playgrounds and worker-bundler's tests all exercise (§4).
- Tests: see §6.

#### 7.3 The Worker + React Template

- **Shape.** A Hono server entry, `src/main.tsx` as the client entry, `index.html` and `public/`.
- **Build call.** `createApp({ server, client: "src/main.tsx", jsx: "automatic", jsxImportSource: "react", minify: true, assets })`. `minify: true` makes esbuild define `process.env.NODE_ENV` as `"production"`, so React's production build is used (§1.4).
- **CSS.** Don't import CSS from TypeScript. worker-bundler drops it (§1.4). Instead run Tailwind v4's `compile()` as a separate step:
  - Serve `tailwindcss/index.css` (inlined) and the project's own CSS through `loadStylesheet`.
  - Extract candidates with a regex tokenizer over `src/**`.
  - Call `build(candidates)` and add the result to `assets` as `/styles.css`.
  - No Tailwind plugins at first, since `loadModule` can't evaluate code (§2.1).
  - Decide which Tailwind runs. The platform can bundle one fixed `tailwindcss` into itself. Or it can bundle the project's own `node_modules/tailwindcss` with worker-bundler and run `compile()` in a Dynamic Worker, so the version in `package.json` is the one used. *Decided:* [ADR 0007](../adr/0007-the-platform-compiles-tailwind.md) chose one fixed version built into the platform.
  - Fallback if Tailwind proves too slow or breaks on an upgrade: a plain CSS file passed as its own client entry, which esbuild bundles with its `@import`s (§1.4).
- **HTML.** `index.html` links the stylesheet and the entry the way Vite expects: `<link rel="stylesheet" href="/src/styles.css">` and `<script type="module" src="/src/main.tsx">`. Our build rewrites those two paths to `/styles.css` and `/main.js`. Vite also accepts a stylesheet linked from HTML, so the same file still works after export.
- **Images and fonts.** Keep them in `public/`, read them as bytes (`readFileBytes` in `@cloudflare/shell`, [filesystem.ts L568-640][shell-bytes]), pass them as `ArrayBuffer` assets, and reference them by URL. Don't import them from code (§1.4).
- **Things the Template must avoid**, each because the build would silently do something different from Vite: CSS imports from TS, CSS modules, tsconfig `paths` aliases such as `@/`, and image imports (§1.4, §1.5). `import.meta.env` is Vite-only, so either `define` its common keys in the build or keep it out.
- **Vite config.** Ship a `vite.config.ts` for the exported project only. The platform ignores it (§3). Say so in the Template, so the Agent doesn't edit it expecting an effect. *Superseded:* [ADR 0005](../adr/0005-workspaces-only-work-inside-the-platform.md) decided that Templates ship no Vite config at all. That also makes the Vite-compatible `index.html` paths in the **HTML** item above unnecessary.

#### 7.4 Main risks

1. **worker-bundler is experimental and fails silently in several ways.** Its React client path has no upstream tests, and no project I found uses it (§1.9, §4.4).
2. **Memory.** esbuild's heap stays after the first build, next to ts-rust and Think in 128 MB. No published numbers (§5).
3. **Build time.** esbuild-wasm is about 10× slower than native, and its first use compiles a 14 MB module. No published workerd timings (§1.8).
4. **Tailwind through an internal API.** `compile()` is "internal/undocumented/not public" by its author's words. Its CPU cost on a real candidate set is unmeasured (§2.1).
5. **Divergence from local Vite.** Exported projects built with Vite 8 use Rolldown and the project's plugins. The platform uses esbuild-wasm and our own CSS step. The same source can produce different output (§3).

### 8. Found along the way

- **`@cloudflare/shell` is about to be deprecated.** An open stack of seven PRs, opened 2026-10-12, moves Think onto `@cloudflare/computer`'s `Workspace` and drops Shell from Think ([#2562][pr-2562]). Its sixth PR deprecates Shell "in favour of `@cloudflare/computer`" and adds a migration guide ([#2564][pr-2564]). It says "The two packages use different tables (`cf_workspace_<namespace>` and `vfs_*`), so switching doesn't move any data". None of the seven was merged on 2026-10-13. npm still shows Shell 0.4.3 with no deprecation flag, and `@cloudflare/computer` 0.5.1 was published that day ([npm][npm-computer]). This touches our "files in `@cloudflare/shell`'s `Workspace`" assumption and the naming note in `docs/adr/0003-one-durable-object-per-workspace.md`.
- **Correction to [cloudflare-platform.md](./cloudflare-platform.md) §5.** vibesdk's build doesn't use sucrase, and it doesn't build front-ends (§4.1).

## Open questions

1. What is esbuild-wasm's peak memory when it bundles the React Template in workerd, and what is the peak with a ts-rust Check in the same isolate? Measure with Workers' memory metrics, not estimates.
2. How long does a cold build and a warm build take? Read CPU time from Workers Logs. `Date.now()` only advances after I/O in deployed Workers, so in-code timings of pure-CPU work under-report ([Performance and timers][cf-timers]).
3. Does `createApp({ client: "src/styles.css" })` really emit bundled CSS at `/styles.css`, as the code suggests (§1.4)?
4. What does Tailwind's `compile()` plus `build()` cost in CPU for a realistic React app, and how many false candidates does a regex extractor produce?
5. Should the build run in the Workspace DO, a builder Worker or a Dynamic Worker? This depends on answers 1 and 2 (§5).
6. Does the move from `@cloudflare/shell` to `@cloudflare/computer` change our file store? If it does, can Computer's `vfs_*` tables be read synchronously for the bundler (§8)?

[agents-sha]: https://github.com/cloudflare/agents/tree/b1e3614bb0ad479b05be2e15909e4ccee6308f37
[wb-npm]: https://registry.npmjs.org/@cloudflare/worker-bundler
[wb-pkg]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/package.json
[wb-readme]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L1-L5
[wb-readme-runtime]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L7-L11
[wb-readme-app-quick]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L54-L106
[wb-readme-api]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L112-L143
[wb-readme-app]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L145-L179
[wb-readme-handler]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L181-L355
[wb-readme-storage]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L208-L286
[wb-readme-cache]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L349-L355
[wb-readme-entry]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L357-L364
[wb-readme-do]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L366-L425
[wb-readme-adv]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L499-L503
[wb-readme-jsx]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L505-L516
[wb-readme-loader]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L533-L563
[wb-readme-plugins]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L613-L645
[wb-readme-fs]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L662-L710
[wb-readme-snap]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L712-L755
[wb-readme-lim]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/README.md#L869-L876
[wb-index]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/index.ts#L82-L227
[wb-app]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/app.ts
[wb-app-client]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/app.ts#L245-L277
[wb-bundler-import]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L5-L7
[wb-plugin]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L99-L172
[wb-bundler-build]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L225-L264
[wb-relative]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L270-L314
[wb-loader]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L316-L336
[wb-bundler-init]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L338-L451
[wb-bundler-guard]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/bundler.ts#L342-L368
[wb-resolver]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/resolver.ts#L64-L89
[wb-resolver-pkg]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/resolver.ts#L112-L190
[wb-transformer]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/transformer.ts#L44-L109
[wb-installer]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/installer.ts#L20-L224
[wb-installer-skip]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/installer.ts#L144-L153
[wb-installer-fetch]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/installer.ts#L226-L443
[wb-common]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/common.ts
[wb-fs]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/file-system.ts#L1-L38
[wb-fs-do]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/file-system.ts#L151-L246
[wb-fs-snap]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/file-system.ts#L248-L287
[wb-assets]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/asset-handler.ts#L136-L178
[wb-e2e-skip]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/tests/e2e.test.ts#L785-L970
[wb-vitest]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/tests/vitest.config.ts
[wb-list]: https://data.jsdelivr.com/v1/packages/npm/@cloudflare/worker-bundler@0.2.6?structure=flat
[ex-wbp-server]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/examples/worker-bundler-playground/src/server.ts#L58-L262
[rfc-smh]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/design/rfc-self-modifying-harness.md#L318-L327
[issue-2577]: https://github.com/cloudflare/agents/issues/2577
[issue-2466]: https://github.com/cloudflare/agents/issues/2466
[issue-2008]: https://github.com/cloudflare/agents/issues/2008
[issue-1537]: https://github.com/cloudflare/agents/issues/1537
[issue-1306]: https://github.com/cloudflare/agents/issues/1306
[dw-start]: https://developers.cloudflare.com/dynamic-workers/getting-started/
[esb-list]: https://data.jsdelivr.com/v1/packages/npm/esbuild-wasm@0.28.1?structure=flat
[esb-wasm]: https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.1/esbuild.wasm
[esb-browser]: https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.1/lib/browser.js
[esb-linker]: https://github.com/evanw/esbuild/blob/v0.28.1/internal/linker/linker.go#L3959-L3986
[esb-css]: https://esbuild.github.io/content-types/#css
[esb-platform]: https://esbuild.github.io/api/#platform
[esb-1298]: https://github.com/evanw/esbuild/issues/1298
[esb-2503]: https://github.com/evanw/esbuild/issues/2503
[resolve-exports]: https://github.com/lukeed/resolve.exports/blob/v2.0.3/readme.md
[esb-outfile]: https://github.com/evanw/esbuild/blob/v0.28.1/internal/linker/linker.go#L4044-L4060
[shell-bytes]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L568-L640
[wd-wasm]: https://github.com/cloudflare/workerd/blob/3371391b377a6b8e15bb5fe879a4640f44962032/src/workerd/io/worker-modules.h#L307-L324
[wd-wasm-share]: https://github.com/cloudflare/workerd/blob/3371391b377a6b8e15bb5fe879a4640f44962032/src/workerd/io/worker-modules.h#L78-L89
[pr-2564]: https://github.com/cloudflare/agents/pull/2564
[pr-2562]: https://github.com/cloudflare/agents/pull/2562
[npm-computer]: https://registry.npmjs.org/@cloudflare/computer
[wb-config]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/config.ts#L178-L182
[wd-sha]: https://github.com/cloudflare/workerd/tree/3371391b377a6b8e15bb5fe879a4640f44962032
[react-dom-pkg]: https://cdn.jsdelivr.net/npm/react-dom@19.3.0/package.json
[esb-1921]: https://github.com/evanw/esbuild/issues/1921
[cf-timers]: https://developers.cloudflare.com/workers/runtime-apis/performance/
[tw-sha]: https://github.com/tailwindlabs/tailwindcss/tree/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d
[tw-npm]: https://registry.npmjs.org/tailwindcss/4.3.3
[tw-list]: https://data.jsdelivr.com/v1/packages/npm/tailwindcss@4.3.3?structure=flat
[tw-compile]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/tailwindcss/src/index.ts#L55-L85
[tw-invalid]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/tailwindcss/src/index.ts#L726-L787
[tw-vite-scan]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/@tailwindcss-vite/src/index.ts#L595-L621
[tw-16581]: https://github.com/tailwindlabs/tailwindcss/discussions/16581
[react-email]: https://cdn.jsdelivr.net/npm/@react-email/tailwind@2.0.7/dist/index.mjs
[tw-inline]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/scripts/pre-publish-optimizations.mjs#L7-L8
[tw-browser-ids]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/@tailwindcss-browser/src/index.ts#L96-L185
[tw-atimport]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/tailwindcss/src/at-import.ts#L39-L58
[tw-cl]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/CHANGELOG.md#L23
[tw-optimize]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/@tailwindcss-node/src/optimize.ts#L29-L55
[tw-node]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/packages/@tailwindcss-node/src/compile.ts#L1-L6
[tw-rayon]: https://github.com/tailwindlabs/tailwindcss/blob/c2b24dd15fed1c59dd521bd86082f520c9f5ad0d/crates/oxide/src/scanner/mod.rs#L256
[tw-oxide-wasi]: https://cdn.jsdelivr.net/npm/@tailwindcss/oxide-wasm32-wasi@4.3.3/tailwindcss-oxide.wasi-browser.js
[tw-17558]: https://github.com/tailwindlabs/tailwindcss/pull/17558
[tw-18292]: https://github.com/tailwindlabs/tailwindcss/pull/18292
[tw-play]: https://tailwindcss.com/docs/installation/play-cdn
[uno-core]: https://registry.npmjs.org/@unocss/core/66.11.0
[uno-wind4]: https://unocss.dev/presets/wind4
[uno-runtime]: https://unocss.dev/integrations/runtime
[vaportrail-lib]: https://github.com/raybasedev/vaportrail/blob/4d385f89d3636adf137986f35ab518fd33bd26bc/crates/extractor-wasm/src/lib.rs
[aiji42]: https://github.com/aiji42/cloudflare-workers-tailwind/blob/350810cceffb436906080749e6ee1c75325f1e50/src/index.ts
[postcss-npm]: https://registry.npmjs.org/postcss/8.5.30
[postcss-prevmap]: https://github.com/postcss/postcss/blob/f1aca7ec68ab0cfb96cc9e69520a87f641c5a9e4/lib/previous-map.js
[cf-njs-default]: https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/
[lcss-init]: https://github.com/parcel-bundler/lightningcss/blob/1d680fa14e9a089c92dc0929f869d6757ae91c30/wasm/index.mjs
[lcss-async]: https://github.com/parcel-bundler/lightningcss/blob/1d680fa14e9a089c92dc0929f869d6757ae91c30/wasm/async.mjs#L13
[lcss-dts]: https://github.com/parcel-bundler/lightningcss/blob/1d680fa14e9a089c92dc0929f869d6757ae91c30/node/index.d.ts
[lcss-docs]: https://github.com/parcel-bundler/lightningcss/blob/1d680fa14e9a089c92dc0929f869d6757ae91c30/website/pages/docs.md#L83
[vite8]: https://vite.dev/blog/announcing-vite8
[vite-npm]: https://registry.npmjs.org/vite/8.3.4
[browser-vite]: https://github.com/divriots/browser-vite
[rolldown-pkg]: https://cdn.jsdelivr.net/npm/rolldown@1.2.13/package.json
[rolldown-docs]: https://github.com/rolldown/rolldown/blob/f7de35f45bcd4cb8e4b6d8d11e74fbfb20b03127/docs/guide/getting-started.md#L58-L75
[cf-vite-npm]: https://registry.npmjs.org/@cloudflare/vite-plugin/1.63.2
[cf-vite-blog]: https://blog.cloudflare.com/workers-module-registry-nodejs/
[vibe-sha]: https://github.com/cloudflare/vibesdk/tree/9da158d82c597a0e8f4bf033cdccd1053fb6fb15
[vtpl-sha]: https://github.com/cloudflare/vibesdk-templates/tree/7ea201fafdef44f5dcc5bc05f03b36e3198cebe5
[cfos-sha2]: https://github.com/cloudflare/cloudflare-os/tree/8001c4b0c22dace6ffc67446d739fa7861aee1ea
[wb-cl-133]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/CHANGELOG.md#L133
[vibe-createapp]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/deploy-engine.ts#L197-L204
[vibe-read]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/deploy-engine.ts#L58-L94
[vibe-deployments]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/deploy-engine.ts#L129-L141
[vibe-loader]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L741-L757
[vibe-skill-html]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L16
[vibe-skill-assets]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L233-L237
[vibe-skill-react]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L248-L274
[vibe-skill-bin]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L303
[vibe-skill-css]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L306
[vibe-skill-dual]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L309-L355
[vibe-space-pkg]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/package.json#L30
[vibe-lock]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/bun.lock#L334
[vibe-tpl-var]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/wrangler.jsonc#L218
[vibe-tpl-deploy]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/scripts/deploy.ts#L582-L690
[vibe-bun]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/sandbox/sandboxSdkClient.ts#L1757
[vibe-bypass]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/api/controllers/agent/controller.ts#L202-L212
[vtpl-pkg]: https://github.com/cloudflare/vibesdk-templates/blob/7ea201fafdef44f5dcc5bc05f03b36e3198cebe5/reference/vite-reference/package.json#L14-L101
[vtpl-shadcn]: https://github.com/cloudflare/vibesdk-templates/blob/7ea201fafdef44f5dcc5bc05f03b36e3198cebe5/reference/vite-reference/components.json#L3
[vtpl-tsconfig]: https://github.com/cloudflare/vibesdk-templates/blob/7ea201fafdef44f5dcc5bc05f03b36e3198cebe5/reference/vite-reference/tsconfig.app.json#L16-L19
[vtpl-vite]: https://github.com/cloudflare/vibesdk-templates/blob/7ea201fafdef44f5dcc5bc05f03b36e3198cebe5/reference/vite-reference/vite.config.ts#L1
[vtpl-minjs]: https://github.com/cloudflare/vibesdk-templates/blob/7ea201fafdef44f5dcc5bc05f03b36e3198cebe5/definitions/minimal-js.yaml#L5
[cfos-load]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L4318-L4381
[cfos-todo]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L4564-L4569
[cfos-prompt]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/agent.ts#L635-L660
[cfos-csp]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-frontend/src/GadgetUI.tsx#L105-L115
[cfos-style]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/bundled-blueprints/blueprints/workspace-docs/files/client.ts#L74
[cfos-blueprints]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/bundled-blueprints/README.md#L57-L80
[cfos-agentsmd]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/AGENTS.md#L35
[wb-e2e-react]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/worker-bundler/src/tests/e2e.test.ts#L525-L552
[hono-esb]: https://github.com/honojs/middleware/blob/6496416dd654d7505cd9d0be430011b19a52a44e/packages/esbuild-transpiler/README.md#L5-L38
[hono-esb-wasm]: https://github.com/honojs/middleware/blob/6496416dd654d7505cd9d0be430011b19a52a44e/packages/esbuild-transpiler/src/transpilers/wasm.ts#L16-L31
[vaportrail]: https://github.com/raybasedev/vaportrail/blob/4d385f89d3636adf137986f35ab518fd33bd26bc/README.md#L3-L51
[bundlejs]: https://next.tangled.org/okikio.dev/bundlejs-api/blob/main/docs/architecture.md
[webcontainers]: https://webcontainers.io/guides/introduction
[lovable]: https://lovable.dev/blog/faster-previews-oj
[v0]: https://v0.app/docs/sandbox
[esmsh-gomod]: https://github.com/esm-dev/esm.sh/blob/036591094b6d695604af42b66c9a4c73944f13e4/go.mod#L9
[esmsh-hosting]: https://github.com/esm-dev/esm.sh/blob/036591094b6d695604af42b66c9a4c73944f13e4/HOSTING.md#L3
[rfc-smh-cost]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/design/rfc-self-modifying-harness.md#L363-L367
[cf-wasm]: https://developers.cloudflare.com/workers/runtime-apis/webassembly/
[wasm-shrink]: https://github.com/WebAssembly/design/issues/1397
[cf-rpc]: https://developers.cloudflare.com/workers/runtime-apis/rpc/
[npm-react-dom]: https://registry.npmjs.org/react-dom/19.3.0
[dw-api]: https://developers.cloudflare.com/dynamic-workers/api-reference/
