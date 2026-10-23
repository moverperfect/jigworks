# pingdotgg/ts-rust as an in-Worker type checker

Researched 2026-10-12 against ts-rust commit [`5879a56`][head] (tsc-rs 0.5.0 was published the same day). Source links into the repo are pinned to that commit. Anything marked "(inferred)" is my reading of the evidence. No source states it directly.

## Verdict for our use

You can probably run it in a Worker today for diagnostics and emit, but not off the shelf, and nobody has shown it working on Cloudflare yet.

What works in our favour:

- The repo has a WASM build (`crates/ts_wasm`, target `wasm32-wasip1`). It is single-threaded and does no WASI file I/O. Files come in through a synchronous JS callback interface, and there is a ready-made in-memory `Map` filesystem ([wasm README][wasm-readme], [core.d.ts][core-dts]).
- Its JS loader accepts a precompiled `WebAssembly.Module`. That is the only way Workers allow WASM to load, because they block `WebAssembly.compile` and `instantiate` on raw bytes ([browser.js][browser-js], [CF web standards][cf-standards]).
- 4.2 MB raw (1.8 MB gzip) fits the 64 MiB Worker size limit easily ([wasm README][wasm-readme], [CF limits][cf-limits]).
- Diagnostics come back as JSON objects with UTF-16 positions, and it emits JS and `.d.ts` into the same map ([wasm README][wasm-readme]).

What's missing or unproven:

1. No published artifact. The wasm README says "Nothing here publishes", `ts-rust-wasm` is not on npm, the v0.5.0 release ships native binaries only, and no CI workflow builds the module. We would build it ourselves with Rust, `wasm32-wasip1` and binaryen.
2. Nobody has run it on workerd. The repo never mentions Cloudflare or workerd. The two unknowns that could sink it are memory and stack depth. The isolate cap is 128 MB including the JS heap, and the module reserves a 32 MiB shadow stack in linear memory. The checker recurses deeply, and stack limits already hurt it in Safari workers.
3. It has no language service in WASM. `--lsp` and `--api` are unsupported there. An outside PR that added hover, completions and the rest was closed on 2026-10-11 because the maintainer wants the WASM build kept small. The maintainer said they'd welcome a "WASM + LSP" fork ([PR #51][pr51]).
4. It keeps no state between runs. Each run is a fresh instance and a full cold check, because the compiler keeps one program per process (inferred cost: every check re-parses libs and every file).
5. It is extremely new. The repo has been public for five days, it is at 0.x, and the code is LLM-written and unreviewed: "I've never read a line of this code" ([README][readme]).
6. It follows TypeScript 7.1-dev semantics, so TS 6-era configs may need changes. For example, native TypeScript no longer supports `baseUrl` ([README][readme]).

My recommendation is to spike it, because it is the only option that gives TS 7 semantics in a Worker today. Measure peak memory and stack depth on a realistic project inside `wrangler dev` and then on deployed workerd before committing. Keep the TS 6 JS API with `@typescript/vfs` as the fallback. It is slower and stuck on 6.0 semantics, but it runs in-isolate and has a full language service. Microsoft's official wasip1 build of tsgo is a draft PR. It is on the 7.1 plan, but nothing has shipped.

## Findings

### 1. What it is, who runs it, how mature it is

- GitHub describes it as "An experimental Rust port of the TypeScript 7 compiler (tsc)". It belongs to the `pingdotgg` organisation, is MIT-licensed, is not archived, and had about 1,100 stars on 2026-10-12 ([GitHub API][repo-api]). The LICENSE copyright holder is "T3 Tools Inc." ([LICENSE][license]). The only npm maintainer is `t3dotgg` (theo@ping.gg) ([npm tsc-rs][npm-tsc-rs]).
- Crates and npm packages are labelled "MIT AND Apache-2.0" because the port keeps TypeScript's Apache-2.0 notices and some BSD-3-Clause Go stdlib code ([NOTICE.md][notice], [Cargo.toml][cargo]).
- The GitHub repo was created on 2026-10-07 ([GitHub API][repo-api]), but its history goes back to June 2026. There are commits dated 2026-06-27 ([commits API][early-commits]), and [docs/history.md][history] describes Codex runs from June 22 to July 8. The npm package `tsc-rs` went from 0.0.1 (2026-10-03) to 0.5.0 (2026-10-12), with six GitHub releases between Oct 7 and Oct 12 ([npm][npm-tsc-rs], [releases][releases]).
- Activity is very high and comes from one person. The contributors API lists `t3dotgg` with 7,325 commits and six others with 10 or fewer ([contributors][contributors]). The last push was 2026-10-12 ([GitHub API][repo-api]). The codebase is about 858k lines of Rust in 1,183 files, generated code included (counted from the clone).
- Stated motivations include "Make a fast TypeScript type checker" and "Make a ts checker that can work in WASM with high performance" ([README][readme]).
- Provenance: Claude Opus 5.5 wrote it from scratch over about two weeks, at roughly $24,047 of API-priced tokens, after an earlier GPT-model attempt stalled at about 84% compatibility. The README says everything below its "Slop Line" heading was written by the author's LLMs ([README][readme]).
- Stability: "This is an early release." The README also claims "100% compatibility in every real world project we have tested" ([README][readme]).
- It is a port, not a new checker. The README calls it "a direct port of Microsoft's native TypeScript compiler, which is written in Go". It "keeps Go's algorithms and behavior and has the same command line (`tsc`), language server and API" ([README][readme]).
- It targets TypeScript 7.1.0-dev semantics. It is pinned to microsoft/TypeScript commit `673a5f17d713` (2026-09-29). The closest npm build is `typescript@7.1.0-dev.20260929.1` ([UPSTREAM.md][upstream]). `--version` prints 7.1.0-dev, and `typesVersions` matching uses that version ([README][readme]).
- Conformance: "All 181,711 ported Go tests pass." The README also claims identical diagnostics to Go on TanStack Query core and Hono, and identical CLI output to `tsc` 7 on 60 of 60 open-source repos ([README][readme]). The protected-test snapshot at internal revision R131 lists 169,555 tests: 165,544 passed, 4,011 ignored and none failed. The compiler-runner suite over TypeScript's compiler and conformance cases had 116,095 subtests, with 113,969 passing and 2,126 ignored as "Go runner skips". It does not run the 1,877 fourslash (language-service) baseline files ([goport-protected README][protected]). So the pass rate measures parity with tsgo's own test baselines. Language-service behaviour is not covered by fourslash.

### 2. WASM build and Cloudflare Workers fit

Build and packaging:

- `crates/ts_wasm` builds `tsc` for `wasm32-wasip1` ([wasm README][wasm-readme], [build.sh][build-sh]). Building it needs `rustup target add wasm32-wasip1`, binaryen 132 or later, and Node for `scripts/wasm/build.sh` ([wasm README][wasm-readme]).
- Size is 4.2 MB raw, 1.8 MB gzip and 1.5 MB brotli with Rust 1.98.1, using `opt-level = "z"`, fat LTO, `panic = "abort"` and wasm-opt. A 5.2 MB variant "checks 13 to 18% faster". The lib `.d.ts` files are inside the module as one 0.31 MB LZMA stream ([wasm README][wasm-readme], [Cargo.toml][cargo]).
- It is not published. The wasm README says "Nothing here publishes" ([wasm README][wasm-readme]). The npm registry returns 404 for `ts-rust-wasm` ([npm][npm-ts-rust-wasm]). The v0.5.0 assets are native tarballs and zips only ([v0.5.0][release-050]). No file in `.github/workflows` mentions wasm (grep of [workflows][workflows]). WASM bug fixes do land, though: v0.5.0 includes two outside fixes to the in-memory filesystem (#58, #59) ([v0.5.0][release-050]), and two more WASM fixes were open on 2026-10-12 (#68, #69) ([open issues and PRs][open-items]).

Runtime requirements:

- Threads: none. "wasm has one thread. The checkers run their jobs on the calling thread" ([wasm README][wasm-readme]). The wasm variant of `send_thread_job` runs each job inline ([program.rs][program-rs]). `Cargo.lock` has no rayon. Processes, signals and jemalloc are compiled out for wasm ([ts_goport Cargo.toml][goport-cargo]). No SharedArrayBuffer is needed (inferred from the above and from [core.js][core-js]).
- Filesystem: it makes no WASI fs calls. The host supplies files through two imports, `ts_host.fs` and `fs_take`, and a small WASI shim supplies clocks, random bytes, stdout and stderr. "There is no WASI file system and no `node:wasi`" ([wasm README][wasm-readme]). The shim needs only `WebAssembly`, `TextEncoder`, `TextDecoder`, `crypto` and `performance` ([core.js][core-js]).
- Loading: Workers forbid `WebAssembly.compile`, `compileStreaming`, `instantiate` with a buffer, and `instantiateStreaming` ([CF web standards][cf-standards]). You import the `.wasm` file and Wrangler bundles it ([CF wasm JS][cf-wasm-js]). ts-rust's `loadModule` returns a passed-in `WebAssembly.Module` unchanged, and `runTscAsync` calls `WebAssembly.instantiate(module, imports)` ([browser.js][browser-js], [core.js][core-js]). So the supported Workers path exists (inferred; untested by the project).
- Threading in Workers: "Threading is not possible in Workers" ([CF wasm][cf-wasm]). That doesn't matter for this build.
- Size limit: 64 MiB uncompressed on both plans, with no compressed limit ([CF limits][cf-limits]). 4.2 MB is fine.
- Memory: 128 MB per isolate, "including the JavaScript heap and WebAssembly allocations" ([CF limits][cf-limits]). The module reserves a 32 MiB shadow stack at the start of linear memory ([build.rs][wasm-build-rs]). That leaves roughly 90 MB for the program, checkers and the JS heap (inferred). The project publishes no WASM memory figures. By default `tsc` 7 runs 4 checkers, "and each one makes its own copies of the types it needs" (57% of types on T3 Code `apps/server`) ([README][readme]). The WASM build keeps per-checker state "as a native checker thread does" ([wasm README][wasm-readme]). Passing `--checkers 1` or `--singleThreaded` would likely cut memory (inferred, untested).
- CPU: Workers Free allows 10 ms per request, which is useless here. Paid defaults to 30 s and can go up to 5 min ([CF limits][cf-limits]).
- Startup: Workers must run their global scope within 1 second ([CF limits][cf-limits]). Cloudflare suggests instantiating WASM at the top level ([CF wasm JS][cf-wasm-js]), but ts-rust needs "a new instance of the compiled module" per run ([wasm README][wasm-readme], [lib.rs][wasm-lib]). The compiled module is reused, so only instantiation repeats (inferred).
- Stack: "The checker recurses deeply, so very deep nesting can run out of stack." A Safari worker fails at about 230 terms of `1 + 1 + ...`. Chrome and Firefox workers reach about 1,000 to 1,500 terms, and Node with a 256 MB stack about 30,000. JSPI roughly doubles the depth in Chrome ([wasm README][wasm-readme]). `runTscAsync` uses JSPI when `WebAssembly.promising` exists and there is no `document` ([core.js][core-js]). I found nothing on workerd's stack size or JSPI support.
- Timers: in Workers `performance.timeOrigin` returns 0, and timers only advance after I/O ([CF perf][cf-perf]). The shim builds wall time from `performance.timeOrigin + performance.now()` ([core.js][core-js]). Timestamps and `--extendedDiagnostics` times will be wrong, but diagnostics should not change (inferred).

### 3. API

- In-memory use: `tsc(args, { files, diagnostics: "json" })` takes a map from absolute path to text. It returns `{ exitCode, stdout, stderr, diagnostics, files }`, and `files` includes emitted outputs ([index.d.ts][index-dts], [wasm README][wasm-readme]).
- Custom VFS: `runTsc` and `runTscAsync` (from `ts-rust-wasm/core`) take any `HostFileSystem`. You implement `readFile`, `stat` and `readDirectory`, plus optional `realpath`, `writeFile`, `remove` and `chtimes` ([core.d.ts][core-dts]). These callbacks are synchronous. In a Durable Object, files have to be loaded into memory before the run (inferred).
- Diagnostics use the TypeScript API's `DiagnosticResponse` shape: `fileName`, `pos`/`end`, UTF-16 line/character positions, `code`, `category`, `messageChain` and `relatedInformation` ([core.d.ts][core-dts]).
- tsconfig is supported. The run is ordinary `tsc -p`, and the README example puts `tsconfig.json` in the map ([wasm README][wasm-readme]). It "takes the same options as `tsc`" ([README][readme]).
- `lib.d.ts` files are bundled in the module ([wasm README][wasm-readme]).
- Module resolution is tsc 7's, because it is a direct port ([README][readme]). It reads whatever the host filesystem holds, so `node_modules/@types` and package.json `types`/`exports` only resolve if we put those files in the VFS (inferred). The WASM build has no automatic type acquisition, since the language server isn't available there (inferred).
- Project references: `tsc -b` runs in WASM, but JSON diagnostics are refused with `--build` ([lib.rs][wasm-lib], [wasm README][wasm-readme]). Build mode also keeps every project's synthetic nodes until the run ends, so it uses more memory ([wasm README][wasm-readme]).
- Language service: the native binary has `--lsp` and `--api` ([README][readme]). WASM does not support `--watch`, `--pprofDir`, `--lsp` or `--api` ([wasm README][wasm-readme]). PR #51 would have added a persistent `createLanguageService` with hover, completion, navigation, diagnostics, formatting, semantic tokens and code actions. It grew the module from 4.2 MB to 6.2 MB (2.6 MB gzip). The maintainer closed it unmerged with "we explicitly want to keep the WebAssembly build small" and "We would be cool with a fork that is for WASM + LSP" ([PR #51][pr51]).
- Emit: yes. JS and declarations go into the result map, and the WASM output is "byte-identical" to native tsgo on the project's diff harness ([wasm README][wasm-readme]).
- Other: WASM output is English only (no message catalogs), and plugins that start processes don't work. Effect diagnostics are built in ([wasm README][wasm-readme], [README][readme]).

### 4. Performance and memory

- Native, as claimed by the project: type checking takes "about half of Go's time" across 60 open-source projects (geometric mean). Across six apps (VS Code, Sentry, Playwright, Excalidraw, TypeORM, tRPC) `tsc-rs main` is "1.76× faster than `tsc` 7" and 13.6× faster than `tsc` 6. `bun check` is faster still at 3.49× vs `tsc` 7, but its diagnostics differ. On T3 Code it took 6.41 s, against 16.07 s for `tsc` 7 and 79.57 s for `tsc` 6. All runs used 16-vCPU runners ([README][readme]).
- WASM: there are no published numbers. `scripts/wasm/bench.mjs` measures cold and warm runs, but no results are committed ([bench.mjs][bench]). WASM loses the 4-checker parallelism, so expect it to be well behind native (inferred). For scale, a reporter on Microsoft's tracker measured an unofficial tsgo wasip1 build at "~12× native wall-clock" ([TypeScript#63858][ts-issue-63858]).
- Memory: the project gives only relative figures. `--fast` raises peak memory by up to 1.5×, `--checkers 8` by 7% to 34%, and lazy members cut it by 4% to 15%. Editor memory starts 12% to 24% above `tsc` and grows about 20 MiB per 1,000 edits ([README][readme]). There are no absolute or WASM memory numbers.

### 5. Known gaps and limitations

- README "Known problems": some monorepos get extra output and TS6059 where workspace sources are reachable through both `node_modules` and a direct import. `tsc -b` can read stale output when projects import each other without a reference. Editor memory grows slowly. `--version` prints 7.1.0-dev ([README][readme]).
- WASM-specific: the unsupported flags above, stack overflow on deep nesting, a panic in `--generateTrace` type display that ends the run, and higher memory in `tsc -b` ([wasm README][wasm-readme]).
- Open correctness issues include a 0.3.0 regression with a false TS2790 on `delete` (#52), a false TS7031 on destructured defaults (#16), and a `const` type-parameter assignability bug (#13). Two more open issues (#20, #25) match upstream behaviour ([issues][issues]).
- Upstream pin: differences that the pinned `tsc` build also shows are treated as upstream behaviour until the next pin ([UPSTREAM.md][upstream]).
- Nobody reviews the code: "I've never read a line of this code" ([README][readme]).

### 6. Alternatives

(a) The `typescript` package's JS compiler API in-Worker:

- `typescript@latest` is now 7.0.2 ([dist-tags][ts-disttags]), and "TypeScript 7.0 ... does not ship with an API". 7.1 is expected "to ship with a new (and different) API" ([TS 7.0 blog][ts7-blog]). An in-process JS API therefore means pinning 6.x, either `typescript@6.0.3` or `@typescript/typescript6`, which "re-exports the TypeScript 6.0 API" ([TS 7.0 blog][ts7-blog], [npm][ts6-compat]).
- Size for `typescript@6.0.3`: `lib/typescript.js` is 9,144,216 bytes, about 1.64 MB gzipped (my own measurement with .NET GZip at its smallest setting). The 107 `lib.*.d.ts` files total 3,783,805 bytes, and `lib.dom.d.ts` alone is 2,349,483 ([jsDelivr file list][ts-603-files], [npm][ts-603]). That fits under 64 MiB. Parsing 9 MB of JS may press on the 1-second startup limit if it is imported at top level (inferred).
- You get the full language service and TS 6.0 semantics. It runs in the V8 heap, so the same 128 MB cap applies (inferred).

(b) Microsoft typescript-go (tsgo):

- `microsoft/typescript-go` was archived on 2026-09-01, and development continues in `microsoft/TypeScript` ([typescript-go][tsgo-repo]).
- There is no published official WASM build. A draft PR by Jake Bailey, a Microsoft team member, adds a wasip1 `tsc.wasm` that "works as a CLI" and can serve the in-process API in browsers. The PR calls it "still a bit experimental" ([TypeScript#64174][ts-pr-64174]). The 7.1 iteration plan lists "Publish wasm (wasip1?) Build" and "Getting Playground Running with wasm". It planned 7.1 stable for 2026-11-24, but beta is already slipping ([TypeScript#63703][ts-71-plan]).
- A third-party reporter measured an unofficial wasip1 build at about 48.6 MB and about 12× slower than native ([TypeScript#63858][ts-issue-63858]).

(c) `@typescript/vfs`:

- Version 1.6.5 is "A Map based TypeScript Virtual File System". It provides `createSystem`, `createVirtualCompilerHost`, `createVirtualTypeScriptEnvironment` (which exposes `env.languageService`) and `createDefaultMapFromCDN` for lib files. Its peer dependency is `typescript: "*"`, and the package itself is 257 KB unpacked ([README][vfs-readme], [npm][vfs-npm]).
- It wraps whatever `ts` you pass in, so in practice it means option (a) with TS 6.x, since TS 7 has no JS API (inferred).

## Open questions

1. What is ts-rust WASM's peak linear memory on a realistic project with `lib.dom`, and does it fit in 128 MB alongside the 32 MiB shadow stack and our JS heap? Does `--checkers 1` or `--singleThreaded` help?
2. What stack depth does workerd give a WASM call, and does workerd expose JSPI (`WebAssembly.promising`)? I found no Cloudflare documentation on either.
3. How long do cold and warm checks take in WASM for a small project? `bench.mjs` exists, but no results are published.
4. Will Wrangler resolve the package's `default` (browser) export rather than `node`, and is per-run `WebAssembly.instantiate` of a 4.2 MB module fast enough on workerd?
5. Will pingdotgg ever publish `ts-rust-wasm`? Does a community "WASM + LSP" fork exist? I did not search for forks.
6. Will Microsoft's wasip1 build (PR #64174) ship in 7.1, and at what size and speed?
7. How do we get third-party `.d.ts` files into the VFS without a `node_modules` install? This applies to every option above.

[head]: https://github.com/pingdotgg/ts-rust/tree/5879a56abc3dc16cf708743c302b1a1ab4f56da7
[readme]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/README.md
[wasm-readme]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/npm/wasm/README.md
[core-dts]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/npm/wasm/core.d.ts
[index-dts]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/npm/wasm/index.d.ts
[core-js]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/npm/wasm/core.js
[browser-js]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/npm/wasm/browser.js
[wasm-lib]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/crates/ts_wasm/src/lib.rs
[wasm-build-rs]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/crates/ts_wasm/build.rs
[cargo]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/Cargo.toml
[goport-cargo]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/crates/ts_goport/Cargo.toml
[program-rs]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/crates/ts_goport/src/program.rs
[build-sh]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/scripts/wasm/build.sh
[bench]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/scripts/wasm/bench.mjs
[upstream]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/UPSTREAM.md
[notice]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/NOTICE.md
[license]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/LICENSE
[history]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/docs/history.md
[protected]: https://github.com/pingdotgg/ts-rust/blob/5879a56abc3dc16cf708743c302b1a1ab4f56da7/docs/goport-protected/README.md
[workflows]: https://github.com/pingdotgg/ts-rust/tree/5879a56abc3dc16cf708743c302b1a1ab4f56da7/.github/workflows
[repo-api]: https://api.github.com/repos/pingdotgg/ts-rust
[contributors]: https://api.github.com/repos/pingdotgg/ts-rust/contributors
[early-commits]: https://api.github.com/repos/pingdotgg/ts-rust/commits?until=2026-06-30T00:00:00Z
[releases]: https://github.com/pingdotgg/ts-rust/releases
[release-050]: https://github.com/pingdotgg/ts-rust/releases/tag/v0.5.0
[issues]: https://github.com/pingdotgg/ts-rust/issues?q=is%3Aissue
[pr51]: https://github.com/pingdotgg/ts-rust/pull/51
[open-items]: https://api.github.com/repos/pingdotgg/ts-rust/issues?state=open
[npm-tsc-rs]: https://registry.npmjs.org/tsc-rs
[npm-ts-rust-wasm]: https://registry.npmjs.org/ts-rust-wasm
[cf-limits]: https://developers.cloudflare.com/workers/platform/limits/
[cf-wasm]: https://developers.cloudflare.com/workers/runtime-apis/webassembly/
[cf-wasm-js]: https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
[cf-standards]: https://developers.cloudflare.com/workers/runtime-apis/web-standards/
[cf-perf]: https://developers.cloudflare.com/workers/runtime-apis/performance/
[ts7-blog]: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
[ts-disttags]: https://registry.npmjs.org/-/package/typescript/dist-tags
[ts-603]: https://registry.npmjs.org/typescript/6.0.3
[ts-603-files]: https://data.jsdelivr.com/v1/packages/npm/typescript@6.0.3?structure=flat
[ts6-compat]: https://registry.npmjs.org/@typescript/typescript6/latest
[tsgo-repo]: https://github.com/microsoft/typescript-go
[ts-pr-64174]: https://github.com/microsoft/TypeScript/pull/64174
[ts-issue-63858]: https://github.com/microsoft/TypeScript/issues/63858
[ts-71-plan]: https://github.com/microsoft/TypeScript/issues/63703
[vfs-readme]: https://github.com/microsoft/TypeScript-Website/tree/v2/packages/typescript-vfs
[vfs-npm]: https://registry.npmjs.org/@typescript/vfs/latest
