# A pnpm lockfile for a Workspace that lives in a Durable Object

Researched 2026-10-13. pnpm source is [pnpm/pnpm at `76d448d`][sha] (2026-10-13). That repo now holds two lines. `pnpm/` is pnpm 12, a Rust rewrite. `pnpm11/` is the JavaScript pnpm 11. On npm, `latest` is pnpm 12.11.2, `next-12` is 12.13.0, `latest-11` is 11.28.2 and `next-11` is 11.28.5 ([dist-tags][npm-pnpm]).

- **Pins.** A few pnpm links use the `v12.11.2` tag instead. Same files, one release older. workerd is pinned to `v1.20261013.1`. Other npm packages are cited at the version that was `latest` today.
- **Line numbers.** Where I give them, they came through a fetch tool and may be off by a line or two.
- **"(inferred)"** marks my own reading. No source states those points directly.

Related: [deps-vfs-editor.md](./deps-vfs-editor.md) §1.4 covers fetching tarballs in a Worker, and §1.6 covers StackBlitz and CodeSandbox.

## Implications for our design

**We can't run pnpm in the Worker, but we can write a `pnpm-lock.yaml` that pnpm accepts.** The cost is in peer dependencies, and mistakes there don't fail CI.

**pnpm itself is out.** The npm `latest` pnpm is now pnpm 12, a native Rust binary. Its WebAssembly build targets StackBlitz WebContainers and needs threads, shared memory and a Node supervisor. Workers have none of these. pnpm 11, the JavaScript line, now only gets bug fixes. It hard-depends on `worker_threads`, `node:sqlite` and `child_process`, and all three are non-functional stubs in workerd. Its resolver also expects a metadata cache and store on disk. workerd's `node:fs` is RAM inside the 128 MB isolate. So running pnpm or its resolver libraries in the DO means forking pnpm (§1, §2).

**A frozen install checks the lockfile. It doesn't recompute it.** `pnpm install --frozen-lockfile` checks:

- the importer's specifiers against `package.json`, including that direct versions satisfy their ranges
- the recorded `settings` against config
- that names are valid and importer links resolve to snapshots
- that every registry entry has an `integrity`, which must match the tarball
- `minimumReleaseAge` (one day by default since pnpm 11), re-applied to every entry

It doesn't check that transitive versions, dedupe choices or peer variants are the ones pnpm would pick (§3.2). So our lockfile has to be *valid*, not *identical*.

**What a subtly wrong lockfile does on the user's machine** (§3.2):

| Mistake | Result |
| --- | --- |
| Specifier drift from `package.json` | `ERR_PNPM_OUTDATED_LOCKFILE` |
| Missing or wrong integrity | Hard failure |
| Dangling snapshot reference | "Broken lockfile" (`ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`), which Nx and turbo prune users have hit |
| A version less than a day old | Rejected by default on pnpm 11 and 12 (inferred from two quotes) |
| Missing `hasBin` | Dependency bins not linked (inferred) |
| Missing `os`/`cpu` | Every platform binary installed (inferred) |
| Wrong peer suffix that is still self-consistent | Installs cleanly and links the wrong peer. Shows up later as duplicate React or wrong types (inferred) |

The last row is the dangerous one.

**pnpm 11 adds another install failure.** Its `strictDepBuilds` default fails installs of packages with unapproved install scripts. An export needs `allowBuilds` in `pnpm-workspace.yaml` whether or not it has a lockfile (§3.2).

**Other formats aren't easier where it matters (§4).**

- **npm.** `package-lock.json` is the most forgiving under `npm ci`, but we would have to pick a physical `node_modules` layout, and its mistakes also surface at run time.
- **Bun.** `bun.lock` is a graph and forgiving on formatting. It fails on stray or unbound entries, and frozen mode isn't the CI default.
- **Yarn.** Berry wants byte-identical output and a checksum of Yarn's own zip, which we can't compute.
- **No format degrades safely.** None fails softly in a way that still guarantees the versions we checked (inferred).
- **pnpm's advantage.** It stores a graph, not a layout, so it is a reasonable target if the user wants pnpm anyway.

**Recommended order (§6):**

1. Keep a hidden resolved list in the DO and export with exact top-level pins and no lockfile. That's days of work, and plain `pnpm install` in CI works. Shape the list like pnpm's `packages` and `snapshots` split, so a writer can be added later.
2. Accept a `pnpm-lock.yaml` that real pnpm wrote, and read it, if the Developer brings one back.
3. Write `pnpm-lock.yaml` ourselves only if frozen installs of fresh exports are a hard requirement. Back it with golden tests that compare our output against real pnpm 12, run in our own CI. Budget weeks, mostly for peers.

## Findings

### 1. Running the pnpm CLI in workerd

Workers sources are pinned to workerd [`v1.20261013.1`][workerd]. Docs pages are cited with their "Last updated" date.

#### 1.1 pnpm 12 is a native executable

- **What pnpm 12 is.** "pnpm 12 is a native executable and does not require Node.js after it is installed" ([installation][install-doc]). Its README says "The pnpm v12 CLI is implemented in Rust" and "The TypeScript pnpm v11 CLI under `../pnpm11/` is maintained for bug fixes" ([README][pnpm12-readme]).
- **What the npm package does.** `pnpm@12.11.2` has 14 `@pnpm/exe.*` platform packages as optional dependencies ([package.json][pnpm12-npm]). `bin/pnpm.mjs` runs the binary with `spawnSync`, and inside WebContainers it stops and says "Install @pnpm/wasm instead" ([pnpm.mjs][pnpm12-bin]).
- **Why that rules out workerd.** workerd can't start processes or load native code. `child_process.spawn`, `exec`, `execSync` and `fork` all throw `ERR_METHOD_NOT_IMPLEMENTED` ([child_process.ts L82-153][wd-cp]).

#### 1.2 `@pnpm/wasm` targets WebContainers, not Workers

- **What it is.** The build "executes the pnpm v12 CLI as threaded WebAssembly inside StackBlitz WebContainers". It targets `wasm32-wasip1-threads`. "The Node supervisor owns the WASI descriptor table, the filesystem permission adapter, network requests, and child processes" ([README][wasm-readme]).
- **What it needs.** pnpm's page says "It requires Node.js 22.13 or newer and shared WebAssembly memory" and calls it experimental ([WebContainers][webcontainers-doc]). The host creates `node:worker_threads` workers and a `WebAssembly.Memory` with `shared: true`, and spawns processes ([README][wasm-readme]).
- **Why workerd can't host it.**
  - workerd's `Worker` constructor throws ([worker_threads.ts L59-62][wd-wt]).
  - "Threading is not possible in Workers" ([Workers WebAssembly][cf-wasm], updated 2026-04-23).
- **Status on npm.** First published 2026-10-03. `latest` is a 0.0.0 placeholder, and `next-12` is 12.13.0 ([npm][npm-pnpm-wasm]).

#### 1.3 pnpm 11 (JavaScript) hits stubs in workerd

pnpm 11 needs Node 22.13 or newer. Its CLI is one bundled `dist/pnpm.mjs` (15.9 MB) plus a separate `dist/worker.js` ([unpkg][pnpm11-dist]). On compat dates from 2026-03-17, workerd marks `child_process`, `worker_threads` and `readline` as "non-functional stubs", and `sqlite` since 2026-01-29 ([Node.js APIs][cf-node], updated 2026-08-12).

| pnpm 11 needs | Where | workerd |
| --- | --- | --- |
| Worker threads for tarball extraction, linking and store imports | `@pnpm/worker` uses `@rushstack/worker-pool` ([index.ts][worker-index]) | `new Worker()` throws ([worker_threads.ts][wd-wt]) |
| Pool size from `os.availableParallelism()` | same | Returns 1. `cpus()` returns `[]` ([os.ts][wd-os]) |
| `node:sqlite` `DatabaseSync` for `$STORE/index.db` | `@pnpm/store.index` ([index.ts][storeidx]) | Stub |
| `child_process.spawn` for lifecycle scripts | `pnpm11/exec/npm-lifecycle/src/spawn.ts` ([spawn.ts][pnpm11-spawn]) | Throws |
| undici `fetch` with a dispatcher, `agentkeepalive` | `pnpm11/network/fetch` ([fetch.ts][pnpm11-fetch]) | `http.Agent` "is a stub implementation that does not support connection pooling or keep-alive" ([http][cf-http]). undici on workerd is untested (inferred) |
| A real disk for the store, `node_modules/.pnpm` symlinks and a metadata cache | throughout | See §1.4 |

#### 1.4 What workerd's `node:fs` is

The docs page ([fs][cf-fs], updated 2026-04-23) says:

- It is an in-memory virtual filesystem with `/bundle` ("always read-only"), `/tmp` (the only writable path) and `/dev`.
- "The contents of `/tmp` are not persistent and are unique to each request."
- Symlinks work in `/tmp`.
- All three API styles exist, "but all operations will be performed synchronously".
- "File permissions and ownership are not supported."
- Timestamps are "always set to the Unix epoch".
- There is no `fs.watch` and no glob API.
- Temp files count toward isolate memory.

The source adds:

- **Hard links work for files.** Directories throw EPERM ([filesystem.c++][wd-fs]).
- **Cloning is impossible.** `copyFile` with `COPYFILE_FICLONE_FORCE` throws.
- **Where `/tmp` lives.** Temp files belong to the IoContext and are "deleted when the IoContext is destructed" ([worker-fs.h][wd-fsh]). A Durable Object runs all its requests in one I/O context ([io-context.h][wd-io]). So in a DO, `/tmp` probably lasts while the instance stays in memory and is lost on eviction (inferred).
- **Paths.**
  - `process.cwd()` starts at the read-only `/bundle` ([process][cf-process]).
  - `os.homedir()` and `os.tmpdir()` return `/tmp/` ([os.ts][wd-os]).
  - workerd reports Node `22.19.0` ([node-version.h][wd-nodever]).

pnpm's store, virtual store and metadata cache would all sit in isolate RAM, inside the 128 MB limit that also holds ts-rust and the Workspace mirror ([Workers limits][cf-limits]). Any of it that should outlive the instance would need copying into SQLite by hand (inferred).

#### 1.5 Prior art

- **Nobody has shipped pnpm or npm inside workerd.** I found no public report of either.
- **Cloudflare's own installer.** `@cloudflare/worker-bundler` 0.2.6 is the closest thing. It "only runs inside the Cloudflare Workers runtime (`workerd`)". It fetches abbreviated packuments, picks with `semver.maxSatisfying`, unpacks with `DecompressionStream` and a hand-written tar parser, and writes one flat `node_modules`. It handles no peers, no optional dependencies, no integrity and no lockfile ([installer.ts][cf-installer]).
- **StackBlitz WebContainers.**
  - They have run real npm, Yarn v1 and pnpm since June 2023 ([StackBlitz blog][sb-blog]), and now pnpm 12 through `@pnpm/wasm`.
  - Their earlier client, Turbo, "relies on the package-lock.json file format from npm to read and write lockfiles" and "does not run install scripts". It has been removed, and its source was never public ([Turbo docs][sb-turbo]).
  - WebContainers run in the browser, and production use needs a commercial licence (see [deps-vfs-editor.md](./deps-vfs-editor.md) §1.6).
- **CodeSandbox Nodebox** installs from the Sandpack CDN, "an open-source Rust package manager that runs in the cloud" ([sandpack-cdn][sandpack-cdn]). I found no lockfile support.
- **Val Town** "doesn't have a package manager like npm" and writes `deno.lock` when a val is saved ([Val Town blog][valtown]).
- **Deno and Bun** read `pnpm-lock.yaml` to seed their own lockfiles. Neither writes one ([Deno][deno-pnpm], [Bun][bun-lock]).

### 2. pnpm's packages as libraries

**The JavaScript packages have new names and a new major line.** pnpm 11 renamed its internal packages by area and versions them 1100.x and up. `@pnpm/core` (1016.3.0) and `@pnpm/npm-resolver` (1005.2.3) are the pnpm 10 line ([core][npm-core]). The pnpm 11 equivalents are:

| Job | pnpm 11 package | Version |
| --- | --- | --- |
| Install engine, including `lockfileOnly` | `@pnpm/installing.deps-installer` | 1104.2.4 ([npm][npm-installer]) |
| Tree resolution and peers | `@pnpm/installing.deps-resolver` | (`pnpm11/installing/deps-resolver`) |
| Registry resolver | `@pnpm/resolving.npm-resolver` | 1104.2.5 ([package.json][npmres-pkg]) |
| Read and write `pnpm-lock.yaml` | `@pnpm/lockfile.fs` | 1100.2.13 ([npm][npm-lockfs]) |
| Lockfile types | `@pnpm/lockfile.types` | 1100.1.4 |
| Frozen-install checks | `@pnpm/lockfile.verification`, `@pnpm/lockfile.settings-checker` | 1100.1.11 ([package.json][verif-pkg]) |

All of them are ESM and declare `engines.node >=22.13`.

**What they pull in from Node.** These are the blockers I found in the resolver path.

- **A worker pool.** `@pnpm/resolving.npm-resolver` imports `@pnpm/worker` ([index.ts][npmres-index]). `@pnpm/worker` imports `node:child_process`, `node:os` and `@rushstack/worker-pool`, and sizes the pool from `os.availableParallelism()` ([worker index.ts][worker-index]). `@pnpm/installing.deps-installer` lists `@pnpm/worker` as a peer dependency ([npm][npm-installer]).
- **SQLite through `node:sqlite`.** The resolver also imports `@pnpm/store.index`, the "SQLite-backed index for the pnpm content-addressable store". It loads `DatabaseSync` from `node:sqlite` and opens `${storeDir}/index.db` ([store index.ts][storeidx]). There is a msgpack file fallback written for "hosts such as StackBlitz WebContainers whose `DatabaseSync` lacks" `exec`. It only kicks in when a connection exists but lacks methods, not when `node:sqlite` is missing ([fallbackDatabase.ts][storeidx-fb]).
- **A metadata mirror on disk.** `createNpmResolver` throws unless `cacheDir` is a string ([index.ts][npmres-index]). `pickPackage` reads packuments from a mirror under `cacheDir` for exact versions, stable ranges and offline modes before it goes to the network ([pickPackage.ts][npmres-pick]). The in-memory cache is only an LRU of 10,000 entries with a 2-minute TTL.
- **Disk writes for the lockfile.** `@pnpm/lockfile.fs` writes with `node:fs`, `write-file-atomic`, `signal-exit` and `@zkochan/rimraf`. Its only pure YAML export is `lockfileYamlDump(obj)`, which is `yaml.dump` with `{ blankLines: true, lineWidth: -1, noCompatMode: true, noRefs: true, sortKeys: false }`. The converter from the in-memory `LockfileObject` and the key sorter are internal ([write.ts][lockfs-write]). `js-yaml` here is the fork `npm:@zkochan/js-yaml@0.0.11` ([pnpm-workspace.yaml][catalog]).
- **The install engine is big.** `@pnpm/installing.deps-installer` has 71 dependencies, including lifecycle scripts, bin linking, hoisting and store packages ([package.json][installer-pkg]).

**`--lockfile-only` is a mode of the full install, not a separate resolver.** The docs say only "When used, only updates `pnpm-lock.yaml` and `package.json`" ([pnpm install][cli-install]). It still runs the same resolver, so it still wants a `cacheDir`, a store configuration and network access (inferred from the resolver code above).

**The JavaScript line is now the old line.** pnpm 12 is "a rewrite of pnpm in Rust" with the same commands, settings and lockfile format ([12.0][blog-12]). npm `latest` already points to 12.x ([dist-tags][npm-pnpm]). Building on the 1100.x packages means building on a line that gets maintenance releases while new behaviour lands in Rust (inferred).

**The Rust crates are not a library we can load either.** `pnpm/crates` has 94 crates, including `lockfile`, `lockfile-verification`, `resolving-npm-resolver` and `resolving-deps-resolver` ([crates][crates]). `pnpm-lockfile` depends on `pnpm-fs` and `rayon` ([Cargo.toml][lockfile-cargo]). The only WASM build is `@pnpm/wasm` (see §1). Compiling the resolver and lockfile crates to plain `wasm32-unknown-unknown` with our own fetch would be a port of pnpm's I/O layer, not a build flag (inferred).

### 3. The `pnpm-lock.yaml` format and what a frozen install checks

#### 3.1 Format

**One version string covers pnpm 9 to 12.** The spec says `lockfileVersion` is a ComVer string with major `9` ([spec 9.0][spec]). pnpm 12's Rust `Lockfile` struct is `LockfileVersion<9>` ([lib.rs][lf-lib]). Its compatibility check reads `comver.major == MAJOR || MAJOR == 9 && comver.major == 12`, and any other major fails with "incompatible with this version of pnpm" ([lockfile_version.rs][lf-ver]). pnpm's own repo lockfile is `lockfileVersion: '9.0'` ([pnpm-lock.yaml][repo-lock]).

**Top-level keys** ([types index.ts][types], [lib.rs][lf-lib]):

- `lockfileVersion`, required.
- `settings`: `autoInstallPeers`, `dedupePeers`, `excludeLinksFromLockfile`, `peersSuffixMaxLength`, `injectWorkspacePackages`. pnpm 12 adds `addMissingPeerTypes`, and with `lockfile.includeResolutionSettings` it also records `autoDedupe`, `dedupeInjectedDeps`, `dedupePeerDependents` and `linkWorkspacePackages` ([freshness.rs][fresh], [v12.10.0][rel-12-10]).
- `catalogs`, `overrides`, `packageExtensionsChecksum`, `pnpmfileChecksum`, `ignoredOptionalDependencies`, `patchedDependencies`, `time`. All optional.
- `importers`, keyed by project path (`.` for a single project).
- `packages`, keyed by `name@version`.
- `snapshots`, keyed by `name@version` plus a peer suffix.

A second YAML document at the top of the file can hold the "env lockfile" for `configDependencies` and `devEngines.packageManager` ([11.0][blog-11], [types index.ts][types]). A plain project without those doesn't need it (inferred).

**`importers`.** Each dependency field (`dependencies`, `devDependencies`, `optionalDependencies`) maps a name to `{ specifier, version }` ([lockfileFileTypes.ts][types-file], [spec 9.0][spec]). `version` carries the peer suffix, for example `21.2.3(@types/node@22.19.19)(typescript@6.0.3)` ([pnpm-lock.yaml][repo-lock]).

**`packages`** holds facts about the published package ([types index.ts][types]):

- `resolution` is required. For the npm registry it is `{integrity: sha512-...}`. A `tarball` URL is added when it can't be derived from the registry.
- Optional: `engines`, `cpu`, `os`, `libc`, `hasBin: true`, `deprecated`, `bundledDependencies`, `peerDependencies` and `peerDependenciesMeta` (`{name: {optional: true}}`).
- `resolution` can also carry a `revision` number for registry revisions. An entry without one is revision 0 ([12.0][blog-12], [types index.ts][types]).

An example from pnpm's own lockfile:

```yaml
  '@conventional-changelog/git-client@3.2.0':
    resolution: {integrity: sha512-sD/E0vzp...}
    engines: {node: '>=22'}
    peerDependencies:
      conventional-commits-filter: ^6.0.1
      conventional-commits-parser: ^7.1.3
    peerDependenciesMeta:
      conventional-commits-filter:
        optional: true
```

**`snapshots`** holds how this copy is wired. There is "one entry per directory in the virtual store" ([spec 9.0][spec]). Fields are `dependencies`, `optionalDependencies` (both name to version-with-suffix), `transitivePeerDependencies` (a list of names) and `optional: true` ([types index.ts][types]). Example:

```yaml
  '@pnpm/fetch@1001.0.0(@pnpm/logger@1001.0.1)(supports-color@10.2.2)':
    dependencies:
      '@pnpm/core-loggers': 1001.0.9(@pnpm/logger@1001.0.1)
    transitivePeerDependencies:
      - domexception
      - supports-color
```

**Peer suffixes.** `createPeerDepGraphHash` formats each resolved peer as `name@version`, sorts them, joins with `)(`, and wraps the result in parentheses. A peer that has its own peers carries its own suffix, which nests: `button@1.0.0(react@16.0.0(react-dom@16.0.0))`. If the suffix is longer than `peersSuffixMaxLength` (default 1000), it becomes `(<short hash>)` ([deps.path index.ts][depspath], [spec 9.0][spec]). The suffix depends on peers resolved through the whole ancestry, not just the package's own peers. A package with no peers still gets variants when one of its dependencies has unresolved peers ([how peers are resolved][peers-doc]).

**Formatting.** pnpm sorts keys in its own order, then dumps YAML with unlimited line width and blank lines between entries. Small maps such as `resolution` and `engines` come out in flow style `{...}` ([write.ts][lockfs-write], [pnpm-lock.yaml][repo-lock]).

A frozen install parses the YAML, so byte-for-byte formatting shouldn't matter (inferred). Turborepo's Go re-serialiser relies on the same thing ([vercel/turbo#1819][turbo-pr]). The next non-frozen `pnpm install` would probably reformat the file (inferred).

#### 3.2 What `pnpm install --frozen-lockfile` checks

Frozen mode is on "by default in CI environments" only "if a lockfile is present". When on, "pnpm doesn't generate a lockfile and fails to install if the lockfile is out of sync with the manifest / an update is needed or no lockfile is present" ([pnpm install][cli-install]).

**Importer against `package.json`** ([satisfiesPackageManifest.ts][satisfies], [freshness/manifest.rs][fresh-manifest]):

- The flat union of specifiers in `dependencies`, `devDependencies` and `optionalDependencies` must equal the lockfile's specifiers. Comparison is exact string equality, plus special cases for git and `tool:` specifiers. So `"react": "18.3.1"` needs `specifier: 18.3.1`.
- Each name must sit in the same field, and each locked direct version must satisfy the manifest range.
- `dependenciesMeta`, `publishConfig.directory` and `linkDirectory` must match.
- With `autoInstallPeers` on (the default), the root `package.json`'s own `peerDependencies` count as expected `dependencies`.
- Nothing here reads `packages` or `snapshots`. The Rust doc comment says it verifies "the lockfile's importer entry for the same project" ([freshness/manifest.rs][fresh-manifest]).

**Recorded settings against current config** ([getOutdatedLockfileSetting.ts][settings-check], [freshness.rs][fresh]):

- `catalogs`, `overrides`, `packageExtensionsChecksum`, `ignoredOptionalDependencies`, `patchedDependencies` and `pnpmfileChecksum` must match. Absent maps count as empty.
- `settings.autoInstallPeers` and `settings.excludeLinksFromLockfile` are only compared when the lockfile records them.
- `dedupePeers` and `injectWorkspacePackages` default to `false`, and `peersSuffixMaxLength` to 1000, when absent.
- Manifest drift fails with `ERR_PNPM_OUTDATED_LOCKFILE` ([freshness.rs][fresh]).

**A structural and supply-chain gate on every install.** pnpm 12's `lockfile-verification` crate "Runs every active `ResolutionVerifier` against every entry in a lockfile loaded from disk, before any resolver decision or fetch happens". It says a lockfile "generated by a tool that skipped local policy" can't get past it ([lib.rs][verif-lib]). It checks:

- Every importer alias and snapshot name is a valid npm package name.
- Every importer dependency points to an existing snapshot key.
- Registry entries have a registry-shaped resolution ([verify_lockfile_resolutions.rs][verif-run]).
- Every registry tarball entry has a non-empty `integrity`, or it fails with a missing-integrity violation. This runs whatever the policy. pnpm 11's resolver has the same check ([createNpmResolutionVerifier.ts][npm-verifier]).
- `minimumReleaseAge`, when set. Its default has been 1440 minutes (one day) since v11 ([dependency resolution settings][settings-res]). `trustLockfile` defaults to `false`, so `pnpm install` "re-applies the minimumReleaseAge / `trustPolicy: 'no-downgrade'` checks to every entry in the loaded lockfile" ([11.3][blog-11-3]). A lockfile that pins a version published less than a day ago fails on a laptop with default settings (inferred from the two quotes).

**Integrity at fetch time.**

- A tarball that doesn't match the lockfile's integrity fails with `ERR_PNPM_TARBALL_INTEGRITY`. Since 11.4 only `--update-checksums` bypasses this ([11.4][blog-11-4]).
- An entry without integrity fails with `ERR_PNPM_MISSING_TARBALL_INTEGRITY` since 10.34.1. A maintainer: "Every entry in the lockfile needs to have an integrity" ([pnpm#13022][issue-13022]).

**What a frozen install does not check (inferred from the code above):**

- Whether transitive versions satisfy their parents' ranges.
- Whether the tree is the one pnpm would have picked, for example dedupe choices.
- Whether `hasBin`, `os`, `cpu`, `engines` or peer metadata match the real package.

It installs what the lockfile says.

**What wrong metadata does in the installer** ([buildGraphFromPackages.ts][graph-build]):

- `hasBin` comes straight from the lockfile (`hasBin: pkgSnapshot.hasBin === true`), and bin linking filters on it ([linkAllBins.ts][linkbins]). So a missing `hasBin` can leave a dependency's bins unlinked (inferred).
- `os`, `cpu`, `libc` and `engines` also come from the lockfile. A package that fails `packageIsInstallable` is added to `skipped` and left out. So a missing `os`/`cpu` installs every platform binary of esbuild-style packages, and a wrong one drops a binary the machine needs (inferred).
- A snapshot that references a missing entry fails with `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` ("Broken lockfile"). Users of third-party pnpm lockfile writers hit exactly this: Nx pruning ([nx#22778][nx-issue]) and `turbo prune` ([Vercel community][turbo-broken]).

**Other install failures that aren't about the lockfile.**

- `strictDepBuilds` defaults to `true`, so "the installation will exit with a non-zero exit code if any dependencies have unreviewed build scripts". Approvals live in `allowBuilds` in `pnpm-workspace.yaml` ([build settings][settings-build]).
- An exported Workers project that depends on `wrangler` probably pulls in packages with install scripts, such as `workerd` and `esbuild`. So the export needs `allowBuilds` entries whether or not it has a lockfile (inferred). The abbreviated packument's `hasInstallScript` field tells us which packages need one ([npm registry docs][npm-meta]).

#### 3.3 Registry metadata a writer needs

- **Abbreviated packument.** Per version it carries `name`, `version`, `deprecated`, `dependencies`, `optionalDependencies`, `devDependencies`, `bundleDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bin`, `directories`, `dist`, `engines`, `_hasShrinkwrap`, `hasInstallScript`, `funding`, `cpu` and `os`. The registry docs don't list `libc` ([npm registry docs][npm-meta]). `dist.integrity` gives `resolution.integrity`, `bin` gives `hasBin`, and the rest map one-to-one (inferred).
- **Publish times.** The abbreviated form has no `time` ([npm registry docs][npm-meta]). pnpm's resolver works around this. If the package's top-level `modified` is older than the release-age cutoff, every version is old enough. Otherwise it re-fetches the full packument to read `time` ([releaseAgeUpgrade.ts][release-age]). We'd need the same trick to stay inside the one-day rule.

#### 3.4 How hard peer resolution is to reproduce

- **Defaults that shape the output.** `autoInstallPeers` is `true` ("any missing non-optional peer dependencies are automatically installed"). `dedupePeerDependents` is `true`. `strictPeerDependencies` is `false`, so a missing or bad peer is a warning, not a failure ([peer settings][settings-peers]).
- **One setting makes keys simpler.** With `dedupePeers` on, "peer dependency suffixes use version-only identifiers (`name@version`) instead of full dep paths", so the nesting goes away. It is off by default and recorded in `settings` (§3.2). An exported Workspace would have to ship `dedupePeers: true` in `pnpm-workspace.yaml` so the laptop's config matches (inferred).
- **Size of pnpm's version.** In pnpm 11 it spans a dozen-plus files in `deps-resolver/src`, among them `resolvePeers.ts` (312 lines), `resolvePeersOfNode.ts` (396), `resolvePeersFromParents.ts`, `hoistPeers.ts`, `missingPeers.ts`, `peerDiamond.ts`, `breakDepPathAwaitCycles.ts`, `deduplicateDepPaths.ts` and `findPeersCacheHit.ts` ([directory][depsres-dir], [resolvePeers.ts][resolvepeers], [resolvePeersOfNode.ts][resolvepeersnode]). In pnpm 12 the Rust `resolve_peers.rs` is 597 lines plus a `resolve_peers/` module, `hoist_peers` and `dedupe_peer_dependents` ([resolve_peers.rs][rs-peers]).
- **The behaviour itself.**
  - Peers resolve from the ancestors' dependencies.
  - Each distinct peer set makes a separate copy.
  - Packages without peers inherit variants from their children's unresolved peers.
  - `autoInstallPeers` adds missing peers.
  - `dedupePeerDependents` merges variants afterwards.
  - Cycles are cut at a point that changed between v11 and v12. In v11 the result "depends on traversal order". v12 orders cycle members by package ID ([how peers are resolved][peers-doc], [what's different in pnpm 12][blog-12-diff]).
- **What being exact buys us.** Our output only has to be *valid* for a frozen install, not identical to pnpm's (§3.2). It must be identical only if we want a later `pnpm install` on a laptop to produce no diff (inferred).
- **Where the risk sits.** Peer suffixes that are self-consistent but wrong install without error, and the wrong peer is linked. Two copies of React is the classic symptom. That fails at run time or type-check time, not in CI's install step (inferred).
- **Effort.** Reproducing the common cases is weeks of work. The test corpus would be lockfiles produced by real pnpm 12 for a set of `package.json` files (inferred).

#### 3.5 Tools that write `pnpm-lock.yaml` without pnpm

- **Nx** `stringifyPnpmLockfile(graph, rootLockFileContent, packageJson, workspaceRoot)` prunes an existing pnpm-written lockfile. It does not resolve from scratch, and it was "tested only with pnpm lockfile version 5-9" ([pnpm-parser.ts][nx-parser]).
- **`turbo prune`** writes "a pruned lockfile" from the existing one ([turbo prune][turbo-prune]). Its Go serialiser re-emits pnpm's YAML ([vercel/turbo#1819][turbo-pr]).
- **aube**, jdx's package manager written in Rust, reads and writes `pnpm-lock.yaml` v9, `package-lock.json` v2/v3, `bun.lock` and `yarn.lock`. Its docs warn that "preserving the format does not prevent merge conflicts or guarantee identical version selection", and they don't say whether pnpm accepts its output frozen ([aube lockfiles][aube], [docs.rs][aube-crate]). It is a native CLI, not a Worker library (inferred).
- **Not a JavaScript library.** I found no JavaScript library that resolves from scratch and writes `pnpm-lock.yaml`.

### 4. npm, Bun and Yarn lockfiles

Current versions are npm 12.2.0 (bundling `@npmcli/arborist` 10.0.3), Bun 1.4.3 and Yarn 4.18.1. Yarn 6, a Rust rewrite, is at `v6.0.0-rc.22` ([zpm releases][yarn6]). Source is pinned to `npm/cli@v12.2.0`, `oven-sh/bun@bun-v1.4.3` and `yarnpkg/berry@@yarnpkg/cli/4.18.1`.

#### 4.1 npm `package-lock.json` (v3)

- **Shape.** `packages` is keyed by physical path: `""` for the root, then `node_modules/a/node_modules/b`. So we would have to choose a folder layout, not just a graph ([docs][npm-lock-doc]).
- **What goes in each entry.** Each entry copies `version`, the dependency fields, `bin`, `engines`, `os`, `cpu`, `libc`, `hasInstallScript`, `deprecated` and `license` from `package.json`, plus `resolved`, `integrity` and the `dev`/`optional`/`devOptional`/`peer` flags ([shrinkwrap.js][npm-shrinkwrap]).
- **Little is required.** `resolved` can be left out. npm even has `omit-lockfile-registry-resolved` ([config][npm-config]). `integrity` is checked only when present ([reify.js][npm-reify]).
- **`npm ci`.** "The project must have an existing package-lock.json", and "If dependencies in the package lock do not match those in package.json, npm ci will exit with an error" ([npm ci][npm-ci]).
  - In the source, the lockfile seeds the ideal tree. Only edges that are missing or invalid get re-resolved. `validateLockfile` then reports `Missing:` or `Invalid:` entries ([ci.js][npm-ci-src], [validate-lockfile.js][npm-validate]).
  - A layout that differs from npm's own hoisting but resolves under Node's rules should be accepted (inferred).
- **What wrong data does.**
  - A missing `integrity` installs unverified.
  - A missing `bin` loses `.bin` links.
  - A missing `hasInstallScript` silently skips install scripts ([rebuild.js][npm-rebuild]).
  - A missing `os`/`cpu` installs every platform's binary (inferred).
  - A wrong `dev` flag combined with `--omit=dev` drops production packages (inferred).

#### 4.2 Bun `bun.lock`

- **Shape.** JSONC with `lockfileVersion`, `configVersion`, `workspaces`, optional `trustedDependencies`, `overrides` and `catalogs`, then `packages`. Each npm entry is a tuple `["name@version", "", { dependencies, peerDependencies, optionalPeers, os, cpu, bin }, "sha512-..."]`. The empty string means the default registry ([BunLockFile][bun-ref], [bun.lock.rs][bun-rs]).
- **No layout to compute.** Keys are tree paths only where versions conflict, and Bun recomputes hoisting itself.
- **Version.** v3 is current, but Bun "never silently upgrades" a file, so v1 is the most compatible (inferred).
- **Frozen mode.** "`bun ci` is equivalent to `bun install --frozen-lockfile`". "Bun does not enable `--frozen-lockfile` automatically in CI" ([bun install][bun-install]).
  - The check is structural, not textual. It compares placements, resolutions, bins and scripts, then fails with "lockfile had changes, but lockfile is frozen" ([install_with_manager.rs][bun-frozen]).
  - A missing integrity slot or a dependency that can't be bound is a parse error. An unreferenced entry gets cleaned away, which then fails the frozen check. Turborepo hit exactly that ([turborepo#13317][turbo-bun]).

#### 4.3 Yarn Berry `yarn.lock` (4.x)

- **Shape.** A header comment, then `__metadata: {version, cacheKey}`, then entries keyed by comma-joined descriptors such as `"accepts@npm:~1.3.4, accepts@npm:~1.3.5"`. Fields come in a fixed order ([yarn.lock][yarn-lock]). The lockfile version went from 8 at Yarn 4.0.0 to 10 at 4.18.1, so a writer is tied to one Yarn minor (inferred from the constant).
- **The checksum isn't the npm hash.** It is `${cacheKey}/${sha512 of Yarn's own cache zip}`. Reproducing that zip byte for byte without Yarn's libzip code isn't realistic ([Cache.ts][yarn-cache]).
- **Immutable mode.** `enableImmutableInstalls` is "the default on CI", and Yarn "will refuse to change the lockfile in any way" ([yarnrc][yarnrc]). The source compares the regenerated lockfile text with the original before fetching. So any difference in formatting, ordering or metadata fails with YN0028 ([Project.ts][yarn-project]).
- **Hardened mode.** It turns itself on for public-repo PRs on GitHub. It will "query the remote registries to validate that the lockfile content matches the remote information" ([yarnrc][yarnrc]).
- **The one forgiving part.** A missing checksum passes the immutable check and gets filled in during the install (inferred from source).

#### 4.4 Comparison

| | Hand-generate | Frozen/CI strictness | If subtly wrong |
| --- | --- | --- | --- |
| pnpm `pnpm-lock.yaml` 9.0 | Medium-hard. A graph, not a layout, but peer variants must be right (§3.4) | High. On by default in CI. Validates importers, settings, structure, integrity and release age (§3.2) | Loud for structure, integrity and drift. Silent for peer mistakes and missing `hasBin`/`os`/`cpu` |
| npm `package-lock.json` v3 | Medium. Needs a valid `node_modules` layout, but not npm's exact one | Low. `npm ci` only fails if the lockfile tree needs changes | Usually installs. Mistakes show up later as missing bins, skipped install scripts or no integrity check |
| Bun `bun.lock` | Medium. A graph with path keys where versions conflict. Formatting is forgiving | Medium. Structural. Not on by default in CI | Loud for missing integrity, unbound dependencies and stray entries |
| Yarn 4 `yarn.lock` | Hard. Byte-exact output for one Yarn version, and checksums we can't compute | Very high. Text comparison, on by default in CI | Fails on any formatting or version drift |

**Which format degrades most gracefully.** npm's. A partly wrong `package-lock.json` usually still installs under `npm ci`, but the errors then surface at run time. No format fails "softly" in a way that still guarantees the versions we checked (inferred).

#### 4.5 Libraries and prior art for these formats

- **No resolve-and-write library.** Nothing resolves a tree from scratch and writes any of these lockfiles without the package manager.
  - `@npmcli/arborist` is Node-only, with pacote, cacache and run-script.
  - `@yarnpkg/core` needs `fslib`, `libzip`, `got` and `cross-spawn`.
  - `@yarnpkg/parsers` 3.1.0 has a Worker-friendly YAML stringifier, but not Yarn's lockfile generator.
  - Turborepo's `turborepo-lockfiles` crate parses, prunes and re-encodes npm, Yarn, pnpm and Bun lockfiles, but can't build one.
- **Bots shell out.** Renovate delegates lockfile updates to the package manager CLI. Dependabot runs `npm install ... --package-lock-only`.
- **StackBlitz Turbo** read and wrote `package-lock.json` until April 2024 (§1.5).

### 5. Pure-JS building blocks that run in a Worker

Versions are npm `latest` on 2026-10-13. "Built-ins" means Node modules the code imports.

| Package | Version | Built-ins | In a Worker | Notes |
| --- | --- | --- | --- | --- |
| `semver` | 7.8.5 | None. It reads `process.env.NODE_DEBUG` behind a `typeof process` check ([debug.js][semver-debug]) | Yes | pnpm 11 uses it too ([catalog][catalog]) |
| `npm-pick-manifest` | 12.0.0 | None imported. Defaults `nodeVersion` to `process.version` ([index.js][npm-pick]) | Yes, with `nodejs_compat` | Picks the way npm does. Prefers non-deprecated, engine-compatible versions, and the `latest` tag wins if it fits. Silently ignores `before` when the packument has no `time`. Doesn't unwrap `npm:` aliases. pnpm's picking rules differ in details (inferred) |
| `npm-package-arg` | 14.0.0 | `url`, `path`, `os.homedir`, only for `file:` and directory specs ([npa.js][npa]) | Yes, with `nodejs_compat` (inferred) | Parses specifiers |
| `validate-npm-package-name` | 8.0.0 | None | Yes | pnpm 12's gate rejects invalid names (§3.2) |
| `query-registry` | 4.3.0 | None. Uses global `fetch` ([source][query-registry]) | Yes | Fetch client only. `getAbbreviatedPackument` sends the abbreviated `Accept` header. Peer dependency `zod` ^4 |
| `@vltpkg/graph` and friends | 1.3.8 | `@vltpkg/semver` and `spec/browser` none. `pick-manifest` imports `node:fs`. `registry-client` uses `undici` | Partly | The only maintained pure-JS peer-context algorithm I found ([peers.js][vlt-peers]). `lockfileData()` is pure. It writes `vlt-lock.json`, not a pnpm lockfile. In practice we'd copy code, not depend on it (inferred) |
| `@cloudflare/worker-bundler` | 0.2.6 | None. `DecompressionStream` and its own tar parser | Yes, workerd only | See §1.5. A fetch-and-unpack skeleton, not a resolver we'd keep ([installer.ts][cf-installer]) |
| `node-maintainer` (orogene) | 0.3.34 (2023) | None. wasm-bindgen `web` target | Partly | A full tree resolver in WASM, but "doesn't resolve peer dependencies" (the code is a `TODO`). It writes `package-lock.kdl` and takes no custom fetch. Orogene has since gone closed-source ([graph.rs][orogene]) |
| `pacote`, `npm-registry-fetch`, `@npmcli/arborist` | 22.0.0, 20.0.1, 10.0.3 | `fs` and `child_process` through `cacache`, `tar`, `@npmcli/git` and `minipass-fetch` | No | npm's real install stack ([arborist][arborist]) |
| `@pnpm/npm-resolver`, `@pnpm/resolve-dependencies` | 1005.2.3, 1008.8.0 (pnpm 10 line) | `graceful-fs`, `load-json-file`, `rename-overwrite`, `path-temp` | No, not without heavy shims | `resolve-dependencies` pulls in `@yarnpkg/core` ([npm][pnpm10-resolver]). For the pnpm 11 line, see §2 |
| `@yarnpkg/core` | 4.9.2 | `got` (http), `cross-spawn`, `tar` | No | `fslib` has virtual filesystems but no in-memory one |
| esm.sh, jsDelivr `/resolved` | n/a | HTTP services | HTTP only | esm.sh's resolver is Go and uses Masterminds semver, not npm's ([npmrc.go][esmsh]). jsDelivr resolves one package per call and asks to be contacted above 100 requests per minute ([spec][jsdelivr]) |

**What's missing.** Nothing on this list resolves a full tree with pnpm-style peers and writes `pnpm-lock.yaml`. The parts that exist are:

- version picking (`semver`, `npm-pick-manifest`)
- registry fetching (`query-registry`, or our own `fetch`)
- unpacking (worker-bundler's approach, or nanotar/modern-tar from [deps-vfs-editor.md](./deps-vfs-editor.md) §1.4)

Tree building, peer variants and the YAML writer would be ours (inferred).

### 6. Options ranked

Effort assumes one engineer who already has the tarball fetcher from [deps-vfs-editor.md](./deps-vfs-editor.md) §1.4. All estimates are mine (inferred).

**1. (c) No lockfile in the Workspace, plus a hidden resolved list. Do this first.**

- **What it is.** The DO keeps its own record of the exact tree it resolved and type-checked. It's the same data type acquisition needs anyway. An exported zip ships `package.json` with exact top-level versions and no `pnpm-lock.yaml`.
- **Effort.** Days.
- **How CI behaves.** Frozen mode is only the CI default "if a lockfile is present" ([pnpm install][cli-install]), so plain `pnpm install` in CI works and resolves fresh. Transitive versions can drift from what the Check saw. `pnpm install --frozen-lockfile` or `pnpm ci` fails outright with no lockfile.
- **Risk.** Low for us. It doesn't give the user what they asked for.

**2. (d) Let real pnpm write the lockfile outside the DO, and have the DO read it.**

- **What it is.** The Developer, or a CI job in their repo, runs `pnpm install --lockfile-only` once after export and commits the result. If they bring the lockfile back, our resolver reads it as the source of truth for the Check.
- **Why it's cheaper.** Reading `pnpm-lock.yaml` is much easier than writing it. Parse YAML, then walk `importers` and `snapshots` (§3.1).
- **Effort.** About a week for the reader.
- **Risk.** Low.
- **Limit.** Any `package.json` change made inside the Workspace makes the lockfile stale. Frozen installs then fail on specifier mismatch until someone re-runs pnpm. So this only works if dependency changes are rare, or if the DO can update the lockfile, which is option 3.

**3. (a) Our resolver writes `pnpm-lock.yaml`.** Feasible, because a frozen install validates the lockfile rather than recomputing it (§3.2).

The minimum we'd have to get right:

- `lockfileVersion: '9.0'`, with a `settings` block that matches the shipped config.
- `importers` whose specifiers equal `package.json` byte for byte.
- One `packages` entry per `name@version`, with `resolution.integrity` from `dist.integrity`, plus `engines`, `os`, `cpu`, `hasBin`, `deprecated` and peer metadata.
- One `snapshots` entry per peer variant, with correct `dependencies`, `optionalDependencies`, `optional` and `transitivePeerDependencies`. No dangling references.
- Peer suffixes computed the way pnpm does (§3.4). Ship `dedupePeers: true` to avoid nesting.
- No version younger than `minimumReleaseAge` (one day by default) unless we ship an override. This needs `modified`, and sometimes the full packument (§3.3).
- `allowBuilds` entries for every package with `hasInstallScript` (§3.2).

Effort:

- **Weeks**, for exact versions, ranges, dedupe, optional platform packages and the YAML writer.
- **Weeks more**, for peer variants that match pnpm on the common cases, such as React and its renderers, `@types/*` peers, ESLint plugins and Vite plugins.
- **Test harness.** A golden-test corpus where real pnpm 12 produces the expected lockfile. Run it in our own CI, outside the product. Use `pnpm install --frozen-lockfile` to check acceptance and `pnpm dedupe --check` to see whether pnpm would choose differently ([dedupe][dedupe]).

Risk: medium to high.

- Peer mistakes pass CI and break at run time.
- pnpm keeps adding gates. Recent ones are missing-integrity failures (10.34.1), the one-day release-age default (11.0), lockfile re-verification (documented with `trustLockfile` in 11.3) and hard integrity-mismatch failures (11.4). Each new gate could reject a lockfile we write (§3.2).

The upside: the Check, the hidden list and the exported lockfile are one tree, and the Workspace gets the lockfile the user asked for.

**4. (b) Run pnpm, or pnpm's resolver libraries, in the DO. Not viable.**

- pnpm 12 is a native binary, and `@pnpm/wasm` needs threads and a Node supervisor (§1).
- pnpm 11's JavaScript would need a fork. We'd have to replace the worker pool, `node:sqlite` and the disk metadata mirror, and fit 70-plus packages into 128 MB beside ts-rust (§2).
- A user measured the lockfile verification pass alone at 2.3 to 2.5 GB RSS for about 1,400 entries on pnpm 11.28.5 and 12.x. After a fix, 12.11.0 still averaged about 1.45 GB ([pnpm#16656][issue-16656]). That's native and Node, not workerd, but it says something about memory (inferred).
- Effort: months. Risk: high.
- It also tracks the line pnpm is moving away from.

**5. Run `@pnpm/wasm` in the Developer's browser through WebContainers.** This is technically the only way to run real pnpm without a server. But it runs in the browser, not the Worker, and needs a commercial WebContainers licence ([deps-vfs-editor.md](./deps-vfs-editor.md) §1.6). It also stretches ADR 0001 (inferred).

**6. Write a different lockfile format.** Only worth it if pnpm isn't a hard requirement.

- **npm.** `package-lock.json` costs about the same as option 3, because the tree builder is the same work. The peer work is lighter, since npm hoists instead of making variants. But we'd also have to choose a folder layout, and `npm ci` hides mistakes rather than failing.
- **Bun.** `bun.lock` is similar to pnpm's in effort, and frozen mode is opt-in.
- **Yarn Berry.** Not practical (§4.3).

## Open questions

1. **What does the user need the lockfile for?** If they need CI to install the versions the Check saw, options 1 and 2 might be enough. If they need `pnpm install --frozen-lockfile` to pass on any export, we need option 3.
2. **Does the abbreviated packument carry `libc`?** The registry docs don't list it (§3.3). Fetch a musl package such as `@rollup/rollup-linux-x64-musl` with the abbreviated `Accept` header and look. Without `libc`, a generated lockfile would make pnpm install both glibc and musl binaries (inferred).
3. **Where do auto-installed peers go?** I didn't confirm where pnpm records a peer it auto-installed for a transitive package: in the dependent's snapshot `dependencies`, in a hoisted root entry, or both. Settle it with golden tests before writing the peer code.
4. **Do we adopt pnpm's one-day release-age rule?** If our resolver can pick a version published an hour ago, either the export fails on a default pnpm 11 or 12, or we ship `minimumReleaseAge: 0` and weaken the user's supply-chain default. Applying the same rule in our resolver seems better, but it's a product decision.
5. **Which pnpm do we target?** Writing `packageManager` or `devEngines.packageManager` into the exported `package.json` would make the laptop run the major we tested against (inferred). pnpm 9 to 12 share lockfile 9.0, but their verification gates differ.
6. **Does the first non-frozen `pnpm install` rewrite a valid lockfile we wrote?** For example, by reformatting or adding fields we left out. That would be noise in the user's first commit after export. Test it.
7. **Should the Check read the same tree?** If we write a lockfile, type acquisition should read the hidden list or the lockfile, not resolve on its own. Then the Check and the export can't disagree.

[sha]: https://github.com/pnpm/pnpm/tree/76d448dab90e09e05dd1126b8e12e41cdcfe8205
[npm-pnpm]: https://registry.npmjs.org/pnpm
[npm-core]: https://registry.npmjs.org/@pnpm/core/latest
[npm-installer]: https://registry.npmjs.org/@pnpm/installing.deps-installer/latest
[npm-lockfs]: https://registry.npmjs.org/@pnpm/lockfile.fs/latest
[npm-pnpm-wasm]: https://registry.npmjs.org/@pnpm/wasm
[npmres-pkg]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/resolving/npm-resolver/package.json
[npmres-index]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/resolving/npm-resolver/src/index.ts
[npmres-pick]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/resolving/npm-resolver/src/pickPackage.ts
[release-age]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/resolving/npm-resolver/src/releaseAgeUpgrade.ts
[npm-verifier]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/resolving/npm-resolver/src/createNpmResolutionVerifier.ts
[verif-pkg]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/lockfile/verification/package.json
[satisfies]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/lockfile/verification/src/satisfiesPackageManifest.ts
[settings-check]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/lockfile/settings-checker/src/getOutdatedLockfileSetting.ts
[types]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/lockfile/types/src/index.ts
[types-file]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/lockfile/types/src/lockfileFileTypes.ts
[lockfs-write]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/lockfile/fs/src/write.ts
[catalog]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm-workspace.yaml
[storeidx]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/store/index/src/index.ts
[storeidx-fb]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/store/index/src/fallbackDatabase.ts
[worker-index]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/worker/src/index.ts
[installer-pkg]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/installing/deps-installer/package.json
[depsres-dir]: https://github.com/pnpm/pnpm/tree/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/installing/deps-resolver/src
[resolvepeers]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/installing/deps-resolver/src/resolvePeers.ts
[resolvepeersnode]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/installing/deps-resolver/src/resolvePeersOfNode.ts
[depspath]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/deps/path/src/index.ts
[graph-build]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/deps/graph-builder/src/buildGraphFromPackages.ts
[linkbins]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm11/installing/deps-restorer/src/linkAllBins.ts
[crates]: https://github.com/pnpm/pnpm/tree/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates
[lockfile-cargo]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile/Cargo.toml
[lf-lib]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile/src/lib.rs
[lf-ver]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile/src/lockfile_version.rs
[fresh]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile/src/freshness.rs
[fresh-manifest]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile/src/freshness/manifest.rs
[verif-lib]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile-verification/src/lib.rs
[verif-run]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/lockfile-verification/src/verify_lockfile_resolutions.rs
[rs-peers]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/crates/resolving-deps-resolver/src/resolve_peers.rs
[wasm-readme]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm/wasm/README.md
[repo-lock]: https://github.com/pnpm/pnpm/blob/76d448dab90e09e05dd1126b8e12e41cdcfe8205/pnpm-lock.yaml
[spec]: https://github.com/pnpm/spec/blob/master/lockfile/9.0.md
[cli-install]: https://pnpm.io/cli/install
[settings-res]: https://pnpm.io/settings/dependency-resolution
[settings-build]: https://pnpm.io/settings/build
[peers-doc]: https://pnpm.io/how-peers-are-resolved
[install-doc]: https://pnpm.io/installation
[webcontainers-doc]: https://pnpm.io/webcontainers
[blog-12]: https://pnpm.io/blog/releases/12.0
[blog-12-diff]: https://pnpm.io/blog/whats-different-in-pnpm-12
[blog-11]: https://pnpm.io/blog/releases/11.0
[blog-11-3]: https://pnpm.io/blog/releases/11.3
[blog-11-4]: https://pnpm.io/blog/releases/11.4
[rel-12-10]: https://github.com/pnpm/pnpm/releases/tag/v12.10.0
[issue-13022]: https://github.com/pnpm/pnpm/issues/13022
[issue-16656]: https://github.com/pnpm/pnpm/issues/16656
[npm-meta]: https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
[nx-parser]: https://github.com/nrwl/nx/blob/master/packages/nx/src/plugins/js/lock-file/pnpm-parser.ts
[nx-issue]: https://github.com/nrwl/nx/issues/22778
[turbo-prune]: https://turborepo.dev/docs/reference/prune
[turbo-pr]: https://github.com/vercel/turbo/pull/1819
[turbo-broken]: https://community.vercel.com/t/broken-lockfile-on-prune/23823
[aube]: https://aube.sh/package-manager/lockfiles
[aube-crate]: https://docs.rs/crate/aube/2.2.0
[dedupe]: https://pnpm.io/cli/dedupe
[settings-peers]: https://pnpm.io/settings/peer-dependencies
[yarn6]: https://github.com/yarnpkg/zpm/releases
[npm-lock-doc]: https://docs.npmjs.com/cli/v12/configuring-npm/package-lock-json
[npm-config]: https://docs.npmjs.com/cli/v12/using-npm/config
[npm-ci]: https://docs.npmjs.com/cli/v12/commands/npm-ci
[npm-shrinkwrap]: https://github.com/npm/cli/blob/v12.2.0/workspaces/arborist/lib/shrinkwrap.js
[npm-reify]: https://github.com/npm/cli/blob/v12.2.0/workspaces/arborist/lib/arborist/reify.js
[npm-rebuild]: https://github.com/npm/cli/blob/v12.2.0/workspaces/arborist/lib/arborist/rebuild.js
[npm-ci-src]: https://github.com/npm/cli/blob/v12.2.0/lib/commands/ci.js
[npm-validate]: https://github.com/npm/cli/blob/v12.2.0/lib/utils/validate-lockfile.js
[bun-ref]: https://bun.com/reference/bun/BunLockFile
[bun-rs]: https://github.com/oven-sh/bun/blob/bun-v1.4.3/src/install/lockfile/bun.lock.rs
[bun-install]: https://bun.com/docs/pm/cli/install
[bun-frozen]: https://github.com/oven-sh/bun/blob/bun-v1.4.3/src/install/PackageManager/install_with_manager.rs
[turbo-bun]: https://github.com/vercel/turborepo/pull/13317
[yarn-lock]: https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1/yarn.lock
[yarn-cache]: https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1/packages/yarnpkg-core/sources/Cache.ts
[yarn-project]: https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1/packages/yarnpkg-core/sources/Project.ts
[yarnrc]: https://yarnpkg.com/configuration/yarnrc
[workerd]: https://github.com/cloudflare/workerd/tree/v1.20261013.1
[pnpm12-readme]: https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm/README.md
[pnpm12-npm]: https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm/npm/pnpm/package.json
[pnpm12-bin]: https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm/npm/pnpm/bin/pnpm.mjs
[pnpm11-spawn]: https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm11/exec/npm-lifecycle/src/spawn.ts
[pnpm11-fetch]: https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm11/network/fetch/src/fetch.ts
[pnpm11-dist]: https://app.unpkg.com/pnpm@11.28.5/files/dist
[wd-cp]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/node/child_process.ts#L82-L153
[wd-wt]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/node/worker_threads.ts#L59-L62
[wd-os]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/node/os.ts
[wd-fs]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/workerd/api/filesystem.c%2B%2B
[wd-fsh]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/workerd/io/worker-fs.h
[wd-io]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/workerd/io/io-context.h
[wd-nodever]: https://github.com/cloudflare/workerd/blob/v1.20261013.1/src/workerd/api/node/node-version.h
[cf-node]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
[cf-fs]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
[cf-http]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
[cf-process]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/
[cf-wasm]: https://developers.cloudflare.com/workers/runtime-apis/webassembly/
[cf-limits]: https://developers.cloudflare.com/workers/platform/limits/
[cf-installer]: https://github.com/cloudflare/agents/blob/c7abcf9908d8d9a5ba3146445aef9c7a13c93528/packages/worker-bundler/src/installer.ts
[sb-blog]: https://blog.stackblitz.com/posts/announcing-native-package-manager-support/
[sb-turbo]: https://developer.stackblitz.com/docs/platform/turbo
[sandpack-cdn]: https://github.com/codesandbox/sandpack-cdn
[valtown]: https://blog.val.town/lockfiles
[deno-pnpm]: https://docs.deno.com/runtime/migrate/migrate_from_pnpm/
[bun-lock]: https://bun.sh/docs/pm/lockfile
[semver-debug]: https://cdn.jsdelivr.net/npm/semver@7.8.5/internal/debug.js
[npm-pick]: https://cdn.jsdelivr.net/npm/npm-pick-manifest@12.0.0/lib/index.js
[npa]: https://cdn.jsdelivr.net/npm/npm-package-arg@14.0.0/lib/npa.js
[query-registry]: https://cdn.jsdelivr.net/npm/query-registry@4.3.0/dist/get-abbreviated-packument.js
[vlt-peers]: https://cdn.jsdelivr.net/npm/@vltpkg/graph@1.3.8/dist/ideal/peers.js
[orogene]: https://github.com/orogene/orogene/blob/v0.3.34/crates/node-maintainer/src/graph.rs
[arborist]: https://registry.npmjs.org/@npmcli/arborist/latest
[pnpm10-resolver]: https://registry.npmjs.org/@pnpm/resolve-dependencies/latest
[esmsh]: https://github.com/esm-dev/esm.sh/blob/main/server/npmrc.go
[jsdelivr]: https://data.jsdelivr.com/v1/spec.yaml
