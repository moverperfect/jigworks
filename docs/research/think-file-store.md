# The file store under Think, and our `files` on top of it

Researched 2026-10-14. Sources are cloudflare/agents `main` at [`b1e3614`][a] (2026-10-13, the `agents` 0.28.1 release, where Think is still 0.20.2), the seven `deprecate-shell/*` branches behind PRs #2559 to #2565 at their 2026-10-13 heads (the top of the stack is [`b8f7bdf`][b7]), and cloudflare/computer at [`ef00c0a`][c] (the 0.5.1 release). I unpacked the npm tarballs of `@cloudflare/think` 0.20.2, `@cloudflare/shell` 0.4.3, `@cloudflare/computer` 0.5.1 and `agents` 0.28.1 and checked that the shipped code matches those commits. Pages on developers.cloudflare.com are cited with their "Last updated" date. "(inferred)" marks my own reading where no source says it. Nothing was run.

Related: [think-sessions-workspace.md](./think-sessions-workspace.md) §2 and §4 cover Think's `workspace` field and bash tool. [build-and-test-in-isolates.md](./build-and-test-in-isolates.md) §8 first spotted the PR stack, and §1 below corrects its PR numbers.

## Recommendation

- **Stay on Shell's `Workspace` for now.** Think 0.20.2 is the newest release and what `main` still builds. It keeps files in `@cloudflare/shell`'s `Workspace`, table `cf_workspace_default`. The move to Computer is seven open PRs with nothing published (§1). Computer is "PREVIEW ONLY", its shell backend needs the `experimental` flag, and it has no change events or namespaces (§7).
- **Extend Think in ticket 03.** The minimum is one class field that hands Think a Shell `Workspace` we configure (§3). No model or key is needed until a turn runs. Storage would be identical if we waited (§4), but Agent's rules reshape ticket 03's code anyway. Async RPC methods start the lifecycle and sync ones don't, and `destroy`, `sql` and `name` are taken. Meeting that now costs less than in ticket 06 (inferred).
- **Build `files` on that store.**
  - Reads (`list`, `read`, `snapshot`) stay synchronous. They are `SELECT`s on `cf_workspace_default` that decode base64 rows (§5).
  - Writes (`write`, `delete`) go through `this.workspace.writeFile` and `rm`, so they become async. Shell then keeps directory rows, sizes and `onChange` right for Think's tools and bash. Template setup can no longer sit in one `transactionSync` (open question 1).
  - Map `src/index.ts` to `/src/index.ts`, with the root in one constant. Under Computer the root becomes `/workspace` (§7).
  - Keep `/attachments/` hidden. Think 0.20.2 evicts media to `/attachments/evicted/` ([media-eviction.ts L339][a-evict]).
- **Delete a Workspace with Agent's `destroy()`**, not a bare `deleteAll()`, so the isolate resets after the data goes (§6). Rename our current `destroy()`, which would override Agent's.
- **Pin exact versions.** `@cloudflare/think` 0.20.2, `agents` 0.28.1, and `@cloudflare/shell` 0.4.3 as a direct dependency, so the row format can't drift under Think's `^0.4.3`. Add Think's peers `ai` 7.0.140 and `zod` 4.6.7 (`latest` today). Don't add `@cloudflare/computer`. Treat the next Think minor as a data migration, not an upgrade (§7).

## Findings

### 1. Status of the move from Shell to Computer

- The stack is #2559 to #2565, not #2562 to #2568. #2559 moves the harness examples to Computer 0.5.1, #2560 switches Think's `workspace` to Computer, #2561 swaps the tools, #2562 drops Shell from Think, #2563 moves examples and docs, #2564 deprecates Shell, and #2565 deprecates `createExecuteTool`. [#2568][pr2568] is unrelated (OpenCode harness, merged 2026-10-12).
- On 2026-10-14 all seven are open and unmerged, last updated 2026-10-13. The three I checked report `mergeable_state` "clean" ([#2559][pr2559], [#2560][pr2560], [#2564][pr2564]). Their bodies say "merge in order, or merge the top to land them all together".
- **Think 0.20.2 uses Shell.** In the tarball, `dist/think.js` imports `Workspace` from `@cloudflare/shell` and builds one on first start. `package.json` depends on `@cloudflare/shell` `^0.4.3`. `@cloudflare/think` also re-exports that `Workspace`, so importing it from Think gets the exact class Think uses.
- **`main` is the same.** At `b1e3614` Think is 0.20.2, with source dependency `@cloudflare/shell` `>=0.4.0` ([package.json L27][a-think-pkg]) and default `new Workspace({ sql: this.ctx.storage.sql, name: () => this.name })` ([think.ts L3836-L3843][a-think-init]).
- **The top of the stack uses Computer.** Think drops Shell, takes `@cloudflare/computer` `^0.5.1` as a peer ([package.json L23-L55][b7-pkg]), and defaults to Computer's `new Workspace({ storage: this.ctx.storage })` ([think.ts L3775-L3870][b7-think]).
- The changesets mark `@cloudflare/think` and `agents` as minor bumps ([think-computer-workspace.md][b7-cs]), so the Computer-based Think should ship as 0.21.0 (inferred). A caret range on 0.x doesn't cross minors, so `^0.20.2` would not pull it in.
- npm `latest` today is Think 0.20.2, `agents` 0.28.1, Shell 0.4.3 (not marked deprecated) and Computer 0.5.1 ([think][npm-think], [agents][npm-agents], [shell][npm-shell], [computer][npm-computer]). The Computer-based Think exists only as pkg.pr.new preview builds on the PRs, such as `https://pkg.pr.new/agents@2560`. There is nothing newer to pin.

### 2. Shell's `Workspace`, the store Think 0.20.2 uses

- **Construction.** `new Workspace({ sql, namespace?, r2?, r2Prefix?, inlineThreshold?, onChange?, name? })` ([filesystem.ts L96-L116][a-opts]). `sql` takes `ctx.storage.sql`, a D1 database or any `{ query, run }`. The constructor is synchronous and runs no SQL ([L222-L299][a-ctor]).
- **Tables.** Each namespace gets `cf_workspace_<namespace>` and an index `cf_workspace_<namespace>_parent`. `namespace` defaults to `"default"` and must match `^[a-zA-Z][a-zA-Z0-9_]*$`. The first method call creates both plus a root row `/`, then sets an in-memory `initialized` flag ([L325-L369][a-init]).
- **Two instances.** Two instances on the same `sql` and namespace may coexist in one isolate only if `r2`, `r2Prefix` and `inlineThreshold` match. Otherwise the constructor throws. `onChange` is per instance ([L251-L288][a-ctor]).
- **API, all async.** `readFile` (string or null), `readFileBytes`, `writeFile(path, text, mime = "text/plain")`, `writeFileBytes(path, bytes, mime = "application/octet-stream")`, `appendFile`, `deleteFile`, `exists`, `fileExists`, `stat` and `lstat`, `readDir(dir, { limit = 1000, offset })`, `glob`, `mkdir(path, { recursive })`, `rm(path, { recursive, force })`, `cp`, `mv`, symlinks, `diff` and `getWorkspaceInfo` ([L414-L1440][a-api]). Over `SqlStorage` the underlying `exec` is sync, but every method still returns a promise ([L61-L72][a-backend]).
- **Text and binary.** `writeFile` stores UTF-8 text with `content_encoding = 'utf8'`. `writeFileBytes` stores base64 with `'base64'`. `readFile` and `readFileBytes` both decode either form ([L525-L608][a-read], [L610-L848][a-write]).
- **Directories and events.** Writes insert missing parent directories as rows and emit `create` for each ([L1470-L1532][a-parents]). A recursive `rm` deletes descendants with one range `DELETE` and emits a single `delete`, for the top path only ([L1171-L1224][a-rm], [L1534-L1566][a-desc]).
- **Size and R2.** Files of 1,500,000 bytes or more (`inlineThreshold`) go to R2 when a bucket is set. Without one they are stored inline with a `console.warn` ([L808-L812][a-write]). DO SQLite caps a string, BLOB or row at 2 MB ([limits][cf-limits], updated 2026-06-01). So without R2 a text file fails just under 2 MB, and a base64 file at about 1.5 MB of raw bytes (inferred).
- **Paths and locking.** Paths are absolute after normalisation, with `.` and `..` resolved and a 4,096-character limit ([L1599-L1616][a-norm]). There is no locking, so concurrent writes are last-write-wins (think-sessions-workspace.md §2).

### 3. Extending Think in ticket 03

- **Minimum class** (inferred from the sources below):

  ```ts
  import { Think, Workspace as FileStore } from "@cloudflare/think";

  export class Workspace extends Think<Env> {
    override workspace = new FileStore({ sql: this.ctx.storage.sql, name: () => this.name, onChange: (e) => { /* broadcast */ } });
  }
  ```

  wrangler needs nothing new, because `nodejs_compat` and `new_sqlite_classes` are already in `wrangler.jsonc`. `agents`, `ai` and `zod` must be installed as Think's peers.
- **No model or key at construction.** The default `getModel()` throws "Override getModel()..." and only a turn calls it ([think.ts L5205-L5228][a-getmodel]). The default model is "resolved on first read" inside the turn ([L7536-L7540][a-lazy]). `getAIBinding()` is only reached from `resolveModel()` for string model IDs.
- **Reaching the store.** It is `this.workspace`, typed `WorkspaceLike` ([L3757-L3778][a-think-ws]). Without an override, Think assigns it during lifecycle start. So it is `undefined` in the constructor, and in sync methods on a cold instance ([L3836-L3843][a-think-init]).
- **Setting options.** A class-field override exists from construction and keeps the full `Workspace` type. It is where `namespace`, `r2`, `inlineThreshold` and `onChange` go. Think's own doc comment shows this override ([L3766-L3773][a-think-ws]).
- **Agent's lifecycle.** "the public `async` methods your subclass exposes over RPC start the lifecycle before they run", but "Synchronous methods are never deferred". Startup resolves the object's name, so callers must use `getByName()` or `idFromName()` ([lifecycle.md L463-L487][a-lifecycle]). `src/platform/api.ts` already uses `getByName`.
- **Taken names.** `Agent` defines `destroy()`, `sql()` and `name` (agents 0.28.1 type declarations). Our `Workspace.destroy()` would replace Agent's teardown.

### 4. A plain `DurableObject` now, Think in ticket 06

- Think's tools would see the same files if these match (inferred from §2 and §3):
  - The same DO class and object name, so the same SQLite database. Changing a class's base class needs no wrangler migration (inferred).
  - The same table. Think's default namespace is `"default"`, so use the default or override `workspace` with ours.
  - The same `r2`, `r2Prefix` and `inlineThreshold`. These only matter with R2.
  - The same Shell version, so the bundle has one `Workspace` class and one row format.
  - Rows written through Shell's API, not by hand. Think 0.20.2's bash walks the tree with `readDir`, which only finds files whose parent directory rows exist (inferred from [filesystem.ts L1040-L1068][a-readdir]).
- Ticket 06 would then still have to rename `destroy()` and make any method that needs lifecycle state `async`. It must also override `workspace` with our `onChange` instance. Otherwise Agent writes go through Think's default instance, which has no listener (inferred).

### 5. Synchronous reads

- Shell's API can't give them, because every method is async (§2).
- Direct SQL can. `ctx.storage.sql.exec()` returns a cursor to consume synchronously with `.toArray()` ([exec][cf-exec], updated 2026-09-21). The schema ([filesystem.ts L325-L369][a-init]):

  ```sql
  CREATE TABLE IF NOT EXISTS cf_workspace_default (
    path TEXT PRIMARY KEY,               -- '/src/index.ts'; the root row is '/'
    parent_path TEXT NOT NULL,           -- '/src'; '' for the root
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('file','directory','symlink')),
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    size INTEGER NOT NULL DEFAULT 0,     -- bytes
    storage_backend TEXT NOT NULL DEFAULT 'inline' CHECK(storage_backend IN ('inline','r2')),
    r2_key TEXT,
    target TEXT,                         -- symlink target
    content_encoding TEXT NOT NULL DEFAULT 'utf8',   -- or 'base64'
    content TEXT,                        -- NULL when the bytes are in R2
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    modified_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
  ```

- A snapshot is `SELECT path, content, content_encoding FROM cf_workspace_default WHERE type = 'file' AND storage_backend = 'inline'`, with `base64` rows decoded. With no R2 bucket configured, no row is ever `'r2'` (inferred).
- Base64 rows will appear. Think 0.20.2's bash writes changed files back with `writeFileBytes` whenever the store has one, and Shell's does ([tools/workspace.ts L150-L164][a-bash-ops], [L1460-L1506][a-bash-write]). A text file the Agent edits through bash is stored as base64 with `mime_type` `application/octet-stream`. So `mime_type` can't tell text from binary (inferred).
- The table exists only after the first Shell call. Run the same `CREATE TABLE IF NOT EXISTS` in our constructor, or treat "no such table" as empty (inferred).
- Computer has its own sync path. `workspace.provider()` returns dofs' `SQLiteWorkspaceProvider`, with `readFileSync`, `readdirSync` and `statSync` ([workspace.ts L465-L497][c-provider], [provider.ts L355-L398][c-readsync]). It also returns bytes still held in in-memory write buffers, which a raw SQL reader of `vfs_chunks` would miss. Cloudflare says not to write `vfs_*` rows by hand ([migrating-to-computer.md L52][b6-guide]).

### 6. `ctx.storage.deleteAll()` on a SQLite-backed object

- It "removes the entire contents of a Durable Object's private SQLite database, including both SQL data and key-value data", and is atomic ([deleteAll][cf-deleteall], updated 2026-09-21). Agent's doc comment on `destroy()` says it "drops every table" ([index.ts L8376-L8429][a-destroy]).
- **Alarms.** With a compatibility date of 2026-02-24 or later it deletes the alarm too. Earlier dates need `deleteAlarm()` or the `delete_all_deletes_alarm` flag (same page). Ours is 2026-10-01.
- **It is the only full removal.** Dropping tables or keys may leave metadata. An object "fully ceases to exist if, when it shuts down, its storage is empty" ([Remove a Durable Object's storage][cf-remove], updated 2026-07-03).
- **The instance keeps running.** In-memory state lasts until shutdown (inferred from the page above). For Shell that means a stale `initialized = true`, so the next write hits a dropped table (inferred from [filesystem.ts L325-L369][a-init]).
- **Agent's `destroy()` covers this.** It disables alarms, disposes its capabilities, calls `deleteAll()`, then calls `ctx.abort("destroyed")` on the next tick without alarm retry ([index.ts L8403-L8426][a-destroy]). `abort` "immediately resets a Durable Object" ([abort][cf-abort], updated 2026-09-30).
- **Facets.** Each facet has its own SQLite database, and `ctx.facets.delete(name)` deletes one ([facets][cf-facets], updated 2026-10-12). The `deleteAll()` docs don't say whether facet databases go with the parent's. We don't use facets.

### 7. What Think on Computer would change for us

- **Store.** Computer's `new Workspace({ storage: ctx.storage, backends?, mounts?, useThink?, ... })` sets up its schema in the constructor ([workspace.ts L78-L353][c-ws]). The tables are `vfs_meta`, `vfs_nodes`, `vfs_dirents`, `vfs_blobs`, `vfs_blob_bytes` and `vfs_chunks`, plus sync tables. Content sits in SQLite as 512 KiB content-addressed chunks ([core.ts][c-core], [writeFile.ts L29][c-chunk]). `workspace.fs` is async and shaped like `node:fs/promises` ([README L159][c-readme]).
- **No data moves.** "The two packages use different tables, so switching packages does not move your data." Cloudflare's guide has a copy script that writes Shell rows into `/workspace` through `workspace.fs` ([migrating-to-computer.md][b6-guide]).
- **Gaps.** Computer has no `namespace` (one workspace per DO storage) and doesn't spill large files to R2. The copy loses MIME types and timestamps (same guide, L9-L13 and L111-L114). There are no change events: the assistant example "refreshes after each turn instead of on every write, because Computer has no change events" ([#2560][pr2560]).
- **Paths.** Think writes evicted media, fetched responses and skills under `/workspace` ([index.md L1025-L1041][b7-doc]), and `WORKSPACE_ROOT` is `"/workspace"` ([workspace-files.ts L54][b7-wsf]).
- **Bash.** `workspaceBash` and the in-process `bash` tool go: "add a backend to the Workspace to get `exec`" ([index.md L1036][b7-doc]). Computer's worker-shell and worker-javascript backends need a Worker Loader and the `experimental` flag ([README L49, L281-L282][c-readme]). We would write our own `bash` tool in `getTools()`, as think-sessions-workspace.md already suggests (inferred).
- **Maturity.** The README says "PREVIEW ONLY" and "NOT suitable for production use at this time" ([README L9-L13][c-readme]). Computer 0.5.1 can already back Think 0.20.2 with `useThink: true` ([L537][c-readme]). Its compatibility layer has no `writeFileBytes`, though, so bash can't write binaries back and media eviction turns off ([workspace.ts L1452-L1520][c-compat]).

## Open questions

1. Template setup: are several `await this.workspace.writeFile(...)` calls with no other I/O committed as one implicit transaction? If not, write the `info` key last and make setup safe to retry.
2. Does the RPC caller of `destroy()` get its reply before `ctx.abort()` lands? Agent's comments describe an abort racing an RPC reply into a 500 on the alarm path ([index.ts L658-L667][a-destroy-race]).
3. When does the stack merge, and as which versions? Watch #2565. The changesets say minor bumps.
4. Will Computer get namespaces ([computer#219][c-219]), R2 tiering ([computer#217][c-217]) and change events? Can worker-shell run without `experimental`?
5. What does Think's startup cost a Workspace with no chat (tables, host-job alarms)? Measure it in ticket 03.
6. Does `deleteAll()` remove facet databases? The docs don't say.

[a]: https://github.com/cloudflare/agents/tree/b1e3614bb0ad479b05be2e15909e4ccee6308f37
[b7]: https://github.com/cloudflare/agents/tree/b8f7bdfe64bc155fcc84c8a9bf5827570c0c8f4c
[c]: https://github.com/cloudflare/computer/tree/ef00c0a790cb87887bf209fa87838cb1a281220b
[pr2559]: https://github.com/cloudflare/agents/pull/2559
[pr2560]: https://github.com/cloudflare/agents/pull/2560
[pr2564]: https://github.com/cloudflare/agents/pull/2564
[pr2568]: https://github.com/cloudflare/agents/pull/2568
[npm-think]: https://registry.npmjs.org/@cloudflare/think
[npm-agents]: https://registry.npmjs.org/agents
[npm-shell]: https://registry.npmjs.org/@cloudflare/shell
[npm-computer]: https://registry.npmjs.org/@cloudflare/computer
[a-think-pkg]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/package.json#L27
[a-think-ws]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/think.ts#L3757-L3778
[a-think-init]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/think.ts#L3836-L3843
[a-getmodel]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/think.ts#L5205-L5228
[a-lazy]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/think.ts#L7536-L7540
[a-evict]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/media-eviction.ts#L339
[a-bash-ops]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/tools/workspace.ts#L150-L164
[a-bash-write]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/think/src/tools/workspace.ts#L1460-L1506
[a-backend]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L61-L72
[a-opts]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L96-L116
[a-ctor]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L222-L299
[a-init]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L325-L369
[a-api]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L414-L1440
[a-read]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L525-L608
[a-write]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L610-L848
[a-readdir]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L1040-L1068
[a-rm]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L1171-L1224
[a-parents]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L1470-L1532
[a-desc]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L1534-L1566
[a-norm]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/shell/src/filesystem.ts#L1599-L1616
[a-lifecycle]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/docs/agents/lifecycle.md#L463-L487
[a-destroy-race]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/agents/src/index.ts#L658-L667
[a-destroy]: https://github.com/cloudflare/agents/blob/b1e3614bb0ad479b05be2e15909e4ccee6308f37/packages/agents/src/index.ts#L8376-L8429
[b7-pkg]: https://github.com/cloudflare/agents/blob/b8f7bdfe64bc155fcc84c8a9bf5827570c0c8f4c/packages/think/package.json#L23-L55
[b7-think]: https://github.com/cloudflare/agents/blob/b8f7bdfe64bc155fcc84c8a9bf5827570c0c8f4c/packages/think/src/think.ts#L3775-L3870
[b7-cs]: https://github.com/cloudflare/agents/blob/b8f7bdfe64bc155fcc84c8a9bf5827570c0c8f4c/.changeset/think-computer-workspace.md
[b7-doc]: https://github.com/cloudflare/agents/blob/b8f7bdfe64bc155fcc84c8a9bf5827570c0c8f4c/docs/think/index.md#L1025-L1041
[b7-wsf]: https://github.com/cloudflare/agents/blob/b8f7bdfe64bc155fcc84c8a9bf5827570c0c8f4c/packages/think/src/workspace-files.ts#L54
[b6-guide]: https://github.com/cloudflare/agents/blob/4be05d584a88af8fc41b4c49310bdf5426e7b844/docs/shell/migrating-to-computer.md
[c-readme]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/computer/README.md
[c-ws]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/computer/src/workspace.ts#L78-L353
[c-provider]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/computer/src/workspace.ts#L465-L497
[c-compat]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/computer/src/workspace.ts#L1452-L1520
[c-core]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/dofs/src/schema/core.ts#L26-L88
[c-chunk]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/dofs/src/fs/writeFile.ts#L29
[c-readsync]: https://github.com/cloudflare/computer/blob/ef00c0a790cb87887bf209fa87838cb1a281220b/packages/dofs/src/provider.ts#L355-L398
[c-217]: https://github.com/cloudflare/computer/issues/217
[c-219]: https://github.com/cloudflare/computer/issues/219
[cf-exec]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec
[cf-deleteall]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall
[cf-remove]: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#remove-a-durable-objects-storage
[cf-abort]: https://developers.cloudflare.com/durable-objects/api/state/#abort
[cf-facets]: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/#delete
[cf-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
