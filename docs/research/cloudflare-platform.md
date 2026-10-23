# Cloudflare platform for a browser-based agent dev environment

Researched 2026-10-12 and 2026-10-13 against developers.cloudflare.com, blog.cloudflare.com and Cloudflare GitHub repos. GitHub links are pinned to the commits I read: cloudflare/agents [`7945da9`][agents-sha] (2026-10-12), cloudflare/computer [`c798c11`][computer-sha] (2026-10-12), cloudflare/cloudflare-os [`8cbfb2b`][cfos-sha] (2026-10-11) and cloudflare/vibesdk [`9da158d`][vibe-sha] (2026-09-07). "Updated" dates are the "Last updated" stamps on doc pages. "(inferred)" marks my own reading. No source states it directly.

Related notes, not repeated here:

- [ts-rust.md](./ts-rust.md): the Rust/WASM type checker, and the TS 6 `@typescript/vfs` fallback.
- [deps-vfs-editor.md](./deps-vfs-editor.md): type acquisition, VFS libraries (including just-bash internals), the editor choice, agent tool surfaces and esbuild-wasm.

## Implications for our design

These are weighted for the current spike. No containers. The shell is emulated. v1 is edit plus type-check, with Dynamic Workers preview next. Auth is Access with one allowed email, more Developers later. Export is a zip, with no git in v1. The model is Claude via the Anthropic API directly. Projects contain Workers and browser front-ends.

1. **Workers Paid is required.** Free allows 10 ms of CPU per request, which rules out type-checking. Dynamic Workers and Artifacts are Paid-only (§1, §4, §8).
2. **Start from Think, not a bare `Agent`.** `@cloudflare/think` already covers v1 inside one Durable Object (DO) per project. It has the agent loop, message persistence, resumable streams, recovery after eviction, a DO-SQLite workspace, and eight file tools including `bash`. `getModel()` takes any AI SDK model, and Think depends on `@ai-sdk/anthropic`, so Claude direct should work without AI Gateway (inferred). The fallback is `AIChatAgent` if Think's opinions get in the way. There we own the loop but keep resumable streams and recovery. Both are 0.x, and Think is labelled experimental (§3).
3. **Don't build the VFS.** Think's default store is `Workspace` from `@cloudflare/shell`. It keeps one SQLite row per file, inline up to 1.5 MB with R2 above that. Its `onChange` events can feed file-tree updates to the browser. It is experimental (0.4.3), so keep it behind our own interface (inferred). Skip `@cloudflare/computer` for now. It is preview-only, and its in-Worker shell and JS backends need the `experimental` compatibility flag (§3).
4. **The emulated shell already exists.** Think's `bash` tool runs just-bash inside the DO's own isolate against a snapshot of the workspace, then writes the changes back. The snapshot holds at most 1,000 files of up to 1 MB each, with network off and a 30 s timeout. No Dynamic Worker or container is involved (§3.5).
5. **Type-checking has a first-party package.** `@cloudflare/worker-bundler/typescript` runs a TypeScript 6 language service inside workerd. That is the "TS 6 JS API" fallback from [ts-rust.md](./ts-rust.md), already packaged. Its documented gap is a ~23 MB TypeScript tarball download on every cold start, done to extract the lib `.d.ts` files. We would pre-bundle those (inferred). Limits that still bite:
   - Global scope must start within 1 s, so create the language service lazily.
   - Memory is 128 MB per isolate, possibly shared with other DOs.
   - CPU defaults to 30 s. Raise `cpu_ms` to 300,000.
   - Bundle size has stopped mattering. The limit is 64 MiB uncompressed, with no compressed limit since 2026-09-04 (§1, §4).
6. **Dynamic Workers preview fits both project types.** `@cloudflare/worker-bundler`'s `createApp` bundles a server entry, client entries and static assets with esbuild-wasm inside workerd. The host serves the assets and forwards everything else to the Dynamic Worker. This answers open question 3 in [deps-vfs-editor.md](./deps-vfs-editor.md): Cloudflare runs esbuild-wasm in workerd in its own package. Dynamic Workers are in open beta and accept JavaScript, not TypeScript. Use a content hash as the `get(id)` ID so isolates are reused and unique-worker billing stays low. The first 1,000 unique workers a month are included (§4). vibesdk and Cloudflare OS both preview this way (§5).
7. **Access must be hostname-based.** Worker-level Access (`ctx.access`) rejects WebSocket upgrades with a 403, and Agents chat runs over WebSockets. Use a self-hosted Access application on a custom domain. Verify `Cf-Access-Jwt-Assertion` with `jose` against the team's certs and the AUD tag. Cloudflare OS ships the same 40-line check. A one-email policy fits the Zero Trust free plan, and Entra ID is a supported identity provider with group support (§7).
8. **Long Claude streams work. Eviction and deploys are the risk.** A DO has no wall-clock limit while a client or I/O is in flight, and waiting on `fetch` uses no CPU. Deploys restart DOs and drop WebSockets. Think's and AIChatAgent's recovery covers that case. For Anthropic it continues by sending a synthetic user message (§3.4, §6).
9. **Export and git later.** There is no first-party zip helper. `state.createArchive` writes tar. Zipping the workspace with a JS zip library is a small job (inferred). Two first-party options exist for when git arrives: `@cloudflare/shell`'s `createGit` (isomorphic-git over the Workspace), and Artifacts (open beta, billing from 2026-10-14) (§8).

## Findings

### 1. Workers limits

Sources: [Workers limits][wl] (updated 2026-10-08), [DO limits][dol] (updated 2026-06-01), [DO lifecycle][dolife] (updated 2026-09-30).

| Item | Free | Paid | Source |
| --- | --- | --- | --- |
| Worker size | 64 MiB uncompressed | 64 MiB uncompressed | [Workers limits][wl]. "There is no compressed size limit." The old 3 MB / 10 MB compressed check went away on 2026-09-04 ([changelog][size-cl]) |
| Startup (global scope) | 1 s | 1 s | [Workers limits][wl]. Deploys fail with "Script startup exceeded CPU time limit" |
| Memory | 128 MB per isolate | 128 MB per isolate | [Workers limits][wl]. Includes JS heap and Wasm, and is "per-isolate, not per-invocation" |
| CPU per HTTP request | 10 ms | 30 s default, up to 5 min via `limits.cpu_ms` | [Workers limits][wl], [Wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/#limits) |
| CPU per DO request, WebSocket message or alarm | Not stated separately | 30 s default, up to 5 min. Resets on each incoming request or message | [DO limits][dol] |
| Wall clock, HTTP request or DO | Unlimited while the caller is connected | Same | [Workers limits][wl], [DO limits][dol] |
| Wall clock, alarm handler or Cron | 15 min | 15 min | [Workers limits][wl] |
| `waitUntil` after response | 30 s, shared | 30 s | [Context API](https://developers.cloudflare.com/workers/runtime-apis/context/) |
| Subrequests per invocation | 50 external | 10,000 default, up to 10M via `limits.subrequests` | [Workers limits][wl], [changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) |
| Simultaneous open connections | 6 | 6 | [Workers limits][wl] |

- **DO memory.** No separate DO memory limit is documented. Many DOs of one class "may run in the same isolate… and share the 128 MB of memory" ([DO pricing][dop]).
- **DO eviction.** A hibernatable idle DO hibernates after 10 s. A non-hibernatable idle DO is evicted after 70–140 s without requests or events. Pending I/O, such as an outbound `fetch`, holds it in memory "until it completes or for up to 15 minutes from when it starts", per operation ([DO lifecycle][dolife]). Code deploys restart DOs and disconnect all WebSockets ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- **DO throughput.** Each DO is single-threaded, with a soft limit of 1,000 requests/s per object ([DO limits][dol]).
- **WebAssembly.** Workers support "the same set of features that are available in Google Chrome". "SIMD is supported on Workers." "Threading is not possible in Workers", and there is no Web Worker API ([Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)). `eval`, `new Function`, `WebAssembly.compile` and `WebAssembly.instantiate` with a buffer are all blocked. Wasm must be imported as a pre-compiled module ([web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)). No Wasm-specific size limit is documented. The docs warn only that larger Workers start more slowly. A `.wasm` file counts toward the 64 MiB, and top-level instantiation counts toward the 1 s startup (inferred).
- **WebSockets.** The maximum received message is 32 MiB ([WebSockets API](https://developers.cloudflare.com/workers/runtime-apis/websockets/), raised from 1 MiB on [2025-10-31](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)). The Hibernation API allows up to 32,768 connections per DO and a 16 KB `serializeAttachment`. Auto ping/pong doesn't wake the object ([DO state API](https://developers.cloudflare.com/durable-objects/api/state/)).
- **WebSocket billing.** No duration charge accrues while a DO is hibernated. Incoming messages bill as requests at 20:1. With the standard `accept()`, duration is billed for as long as the socket stays open ([DO pricing][dop]).
- **Stale page.** The Agents limits page (updated 2026-06-03) still lists "Max script size 10 MB" and "1 GB" of state per Agent ([Agents limits][agl]). The Workers and DO limits pages are newer and say 64 MiB and 10 GB.

### 2. Durable Object storage, and KV/R2 for file blobs

- **SQLite-backed DOs are GA** (2025-04-07, [changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)). New namespaces must use `new_sqlite_classes` unless the account already has key-value-backed ones ([changelog 2026-07-09](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)).
- **Limits** ([DO limits][dol]):
  - 10 GB per object. The same page's FAQ says 1 GB on Free.
  - 2 MB per string, BLOB or row, and 2 MB for key plus value on the KV API.
  - 100 KB per SQL statement, 100 columns and 100 bound parameters.
  - 50 bytes per LIKE/GLOB pattern.
  - At the limit, writes fail with `SQLITE_FULL`.
- **API.** `transactionSync()` provides transactions, a synchronous KV is available at `ctx.storage.kv`, and point-in-time recovery reaches back 30 days through bookmarks ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
- **Pricing (Paid)** ([DO pricing][dop]):
  - Rows read: 25B/month included, then $0.001/M.
  - Rows written: 50M included, then $1.00/M.
  - Storage: 5 GB-month included, then $0.20/GB-month.
  - Free plan: 100k rows written per day and 5 GB per account.
  - The page still describes storage billing as starting "January 7, 2026 (no earlier)", so whether it is live is unconfirmed.
- **Fit for project files (inferred).** One DO per project, one row per file. Projects of 1–50 MB are far below 10 GB, and edits are transactional and sit next to the agent. Don't mirror a large project fully into memory, because the 128 MB limit is shared. Cloudflare's own agent filesystems take this approach: Workspace (§3.5), Computer and Artifacts all store files in DO SQLite and chunk or spill anything over 2 MB.
- **KV.** Values up to 25 MiB, 1 write/s per key, and eventual consistency: "Changes may take up to 60 seconds or more to be visible" ([KV limits](https://developers.cloudflare.com/kv/platform/limits/), [how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)). That is wrong for editable source (inferred).
- **R2.** 5 GiB per single upload and 1 write/s per key ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/)). It is strongly consistent ([consistency](https://developers.cloudflare.com/r2/reference/consistency/)) and supports `onlyIf` ETag conditions ([R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)). Pricing is $4.50/M Class A operations and $0.015/GB-month, with free egress ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). It suits large or binary files, snapshots and export zips, not per-keystroke writes (inferred).

### 3. Agents SDK, Think and Cloudflare's agent workspace primitives

#### 3.1 What exists and its status

| Package / product | Version at `7945da9` | Status | What it is |
| --- | --- | --- | --- |
| `agents` | 0.28.0 | No status label in docs. Pre-1.0 | `Agent` base class on Durable Objects ([package.json][agents-pkg]) |
| `@cloudflare/ai-chat` | 0.12.1 | No label | `AIChatAgent` plus the `useAgentChat` React hook ([chat agents][chat-docs]) |
| `@cloudflare/think` | 0.20.2 | "Experimental — the API surface is stable but may evolve" ([README][think-readme]). Called "Preview" in [Agents Week][week] | An opinionated chat-agent harness |
| `@cloudflare/shell` | 0.4.3 | "Experimental. API surface is still settling" ([README][shell-readme]) | Durable `Workspace` VFS, `state.*` API and isomorphic-git |
| `@cloudflare/codemode` | 0.5.3 | "Code Mode is experimental and may introduce breaking changes" ([Code Mode][codemode-docs]) | LLM-written JS run in a Dynamic Worker |
| `@cloudflare/worker-bundler` | 0.2.6 | "Experimental… Not recommended for production use" ([README][wb-readme]) | esbuild-wasm bundler, npm installer and TS language service, all inside workerd |
| `@cloudflare/computer` | 0.5.0 | "PREVIEW ONLY… NOT suitable for production use" ([README][computer-readme]) | DO VFS with container, just-bash and JS backends |
| `@cloudflare/coding-agent` | none | RFC "Status: proposed" ([RFC][rfc-coding]) | Claude Code in a Sandbox container behind `AIChatAgent` |
| Artifacts | n/a | Open beta since 2026-10-01 ([changelog][art-cl]) | Git-compatible repos on DOs (§8) |

#### 3.2 The `Agent` class

- **Layering.** `DurableObject` → `Server` (partyserver) → `Agent` → `AIChatAgent` ([Agent class][agent-class], updated 2026-08-17).
- **Built-ins** (same page):
  - `this.state` and `setState()`.
  - `this.sql`.
  - `@callable()` RPC.
  - `schedule` and `cancelSchedule`.
  - `queue`.
  - `this.mcp` and `addMcpServer()`.
  - `keepAlive()` and `keepAliveWhile()`.
  - `broadcast()`.
  - `routeAgentRequest`.
  - `onBeforeConnect` and `onBeforeRequest` hooks on `routeAgentRequest`, which are the place for an auth check ([routing.md][routing]).
- **State sync.** `setState()` persists to SQLite and is "broadcast to all connected WebSocket clients". React's `useAgent` gets `onStateUpdate`, and `validateStateChange` can reject writes. Keep state small and put large data in SQL, because the whole state goes out on every change ([state][state-docs], updated 2026-06-03).
- **Scheduling.** Accepts a delay, a `Date` or a cron string, plus `scheduleEvery`. It is backed by DO alarms and a SQLite table, with "Each task (including payload) can be up to 2MB" and a practical limit of "tens of thousands per agent" ([schedule tasks][sched], updated 2026-06-03).
- **MCP.** `addMcpServer()` acts as a client. For servers, `createMcpHandler` over Streamable HTTP is now recommended over "the deprecated `McpAgent` path" ([remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), updated 2026-07-27).
- **Fibers.** `runFiber()` registers work in SQLite, keeps the agent alive with a 30 s alarm heartbeat, and checkpoints with `ctx.stash()`. After eviction, `onFiberRecovered()` gets the last snapshot. "The original lambda is gone", and there are "No automatic retries" ([durable execution][fibers], updated 2026-08-20).

#### 3.3 AIChatAgent vs Think

- **`AIChatAgent`** is a protocol adapter. You override `onChatMessage` and return `streamText(...).toUIMessageStreamResponse()`. You own the model call and the tools ([chat agents][chat-docs], updated 2026-09-15). It provides:
  - Message persistence in SQLite.
  - Server tools, client tools (`onToolCall`) and approvals (`needsApproval`).
  - Resumable streaming.
  - Durable recovery.
- **Think** "extends `Agent`, as `AIChatAgent` does". It uses the same `cf_agent_chat_*` WebSocket protocol, but "makes those decisions by default". You implement `getModel()` and override individual hooks ([Think][think-docs], updated 2026-08-20). On top of AIChatAgent it adds:
  - Structured sessions.
  - Non-destructive compaction.
  - Context blocks.
  - FTS5 search.
  - Sub-agent RPC.
  - Built-in workspace tools.
- **Think's model hook.** The docs example uses Workers AI (`@cf/moonshotai/kimi-k2.6`). Think's own dependencies include `@ai-sdk/anthropic` and `@ai-sdk/openai` ([think package.json][think-pkg]), so a direct Anthropic model fits `getModel()` (inferred).
- **`runTurn()`** is marked "stable in shape, but may evolve before Think graduates out of experimental" ([Think][think-docs]).
- **Which to use (inferred).** Think is the faster spike. AIChatAgent is the escape hatch if we need full control of the Anthropic request, for example Anthropic-native tools or prompt caching settings.

#### 3.4 Resumable streams and recovery

- **Client disconnects.** "Streams automatically resume when a client disconnects and reconnects." Chunks are buffered in SQLite while the server keeps streaming. A browser abort doesn't cancel the server turn unless `cancelOnClientAbort: true` is set ([chat agents][chat-docs]).
- **DO eviction** is a separate mechanism. "It does not cover Durable Object eviction." Each turn runs inside `runFiber()`. On restart, the framework rebuilds the partial response and calls `onChatRecovery`, which by default continues the turn via `continueLastTurn()` ([chat agents][chat-docs]).
  - The budgets are `maxAttempts` 10, `noProgressTimeoutMs` 5 min and `maxRecoveryWork` 1,000.
  - "Durable recovery is always on."
  - The strategy varies by provider. Anthropic continues by sending a synthetic user message.
- **Think specifics.** Think adds a stream-stall watchdog. Its wait, stream and submit paths all run inside a recovery fiber ([Think][think-docs]). It also replays the "recovering" signal to reconnecting clients, which `@cloudflare/ai-chat` doesn't ([chat agents][chat-docs]).
- **Mid-stream eviction** "permanently severs the LLM connection", which is why recovery exists ([chat agents][chat-docs]).

#### 3.5 Workspace (`@cloudflare/shell`) and Think's built-in tools

- **Storage.** Every file, directory and symlink is a row in `cf_workspace_{namespace}`, keyed by path and indexed on `parent_path`. Content is stored inline below 1.5 MB. Above that it goes to R2, or inline with a warning if no bucket is configured ([workspace design][ws-design], [docs][shell-docs]).
- **Backends.** It works on DO `SqlStorage`, D1, or any `{query, run}` backend ([docs][shell-docs]).
- **Change events.** `onChange` fires on create, update and delete, "designed for wiring to `agent.broadcast()` for real-time client sync" ([workspace design][ws-design]).
- **Documented gaps** ([workspace design][ws-design]):
  - No file locking, so concurrent writes are last-write-wins.
  - A directory `mv` is O(n).
  - `writeFileStream` buffers everything, with a 100 MB cap.
  - `diff` rejects files over 10,000 lines.
- **The `state.*` API** adds glob, search and replace, JSON helpers, tar and gzip, and `planEdits`/`applyEdits`, which roll back by default ([README][shell-readme]).
- **Think's eight tools.** Every Think agent gets `this.workspace` and eight tools: `read`, `write`, `edit` (fuzzy find-and-replace), `list`, `find`, `grep`, `delete` and `bash` ([Think tools][think-tools], updated 2026-08-18).
- **Default construction.** Think constructs `new Workspace({ sql: this.ctx.storage.sql, name })` unless a subclass overrides `workspace`. The type is `WorkspaceLike`, so a custom store can replace it ([think.ts L3757-3843][think-ws]).
- **How `bash` works** ([workspace.ts L1148-1317][think-bash]):
  - The tool calls `new Bash({ files, cwd, defenseInDepth: true, network })` from `just-bash` inside the Think DO itself.
  - It snapshots the workspace into just-bash's in-memory FS. Defaults are at most 1,000 files and 1 MB per file, and anything skipped is reported as `skippedFiles`.
  - It runs the script with a 30 s abort timeout. On timeout the exit code is 124.
  - It diffs the in-memory FS against the snapshot and writes created, updated and deleted files back to the workspace. `/bin`, `/usr`, `/dev`, `/proc` and `/sys` are excluded.
  - It returns stdout and stderr truncated to 64 KB, plus `changedFiles`.
  - Network is off unless `workspaceBash` sets `network`, and `workspaceBash = false` removes the tool ([Think tools][think-tools]).
  - So the shell is a TypeScript bash emulator sharing the agent's isolate and its 128 MB. It is not a sandbox boundary, and just-bash says "All execution happens without VM isolation" (see [deps-vfs-editor.md](./deps-vfs-editor.md) §2).
- **Code execution tool.** Think's optional `createExecuteTool(this)` runs JS in a Dynamic Worker through `@cloudflare/codemode`. It needs a `worker_loaders` binding ([Think tools][think-tools]).

#### 3.6 Other primitives

- **Project Think's "execution ladder"** ([blog, 2026-04-15][think-blog]):
  - Tier 0: Workspace.
  - Tier 1: Dynamic Worker (codemode).
  - Tier 2: npm via worker-bundler.
  - Tier 3: Browser Run.
  - Tier 4: Sandbox container.
  - "The agent should be useful at Tier 0 alone." Our v1 is Tier 0 plus type-checking.
- **`@cloudflare/computer`** ([README][computer-readme], [blog 2026-08-03](https://blog.cloudflare.com/cloudflare-computer/)):
  - A DO-SQLite filesystem with a `node:fs/promises`-like `workspace.fs`, about 10 GB per workspace, an isomorphic-git client and an Artifacts helper.
  - It has one `runtime.exec()` surface over three backends: a container FUSE mount, just-bash in a Dynamic Worker, or JS in a Dynamic Worker.
  - The two Worker backends need the `experimental` compatibility flag ([README][computer-readme]). Cloudflare rejects experimental flags at deploy with error 10021 ([workers-sdk #2858](https://github.com/cloudflare/workers-sdk/discussions/2858), 2023). Dynamic Workers' `allowExperimental` is "not usable in production" ([API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)). So these backends are probably unusable on a normal account today (inferred).
- **Coding-agent RFC.** [`rfc-coding-agent.md`][rfc-coding] ("Status: proposed") would put Claude Code in a Sandbox container behind `AIChatAgent`. It lists "A Workers-native coding runtime" with preview via `env.LOADER` as a future direction. It needs containers, so it is out of scope for us, but it confirms Cloudflare sees both shapes.

### 4. Running the code the agent writes

- **Dynamic Workers (Worker Loader).**
  - Open beta since 2026-03-24, "available to all paid Workers users" ([changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/), [blog](https://blog.cloudflare.com/dynamic-workers/)). Docs now live at [developers.cloudflare.com/dynamic-workers](https://developers.cloudflare.com/dynamic-workers/) (updated 2026-10-12).
  - API ([API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)):
    - `load(code)` creates a fresh isolate on every call.
    - `get(id, cb)` caches by ID, though reuse is "not guaranteed". The callback must return identical code for a given ID.
    - `WorkerCode` is `{ compatibilityDate, compatibilityFlags, mainModule, modules, env, globalOutbound, tails }`. Modules can be `js`, `cjs`, `py`, `text`, `data`, `wasm` or `json`.
  - TypeScript "must be compiled to JavaScript before being passed to load() or get()" ([getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)).
  - `globalOutbound: null` blocks `fetch` and `connect`. An `HttpGateway` stub can filter outbound requests or inject credentials ([egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)).
  - Static assets are served by the host from KV or R2 ([static assets](https://developers.cloudflare.com/dynamic-workers/usage/static-assets/)).
  - Durable Object Facets give each loaded app its own SQLite database ([facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)).
- **Dynamic Workers limits and pricing.**
  - At most 4 Dynamic Workers in flight per Worker request and 10 per DO ([limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/)).
  - CPU and subrequests can be capped per load ([usage limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)).
  - Pricing is 1,000 unique workers a month included, then $0.002 per unique worker per day, billed since 2026-05-26 ([pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)).
  - No code-size or memory limit specific to Dynamic Workers is documented.
- **Loading a module graph from our VFS.**
  - `@cloudflare/worker-bundler` exposes `createWorker({ files })` and `createApp({ files, server, client, assets })`. Both take a `Record<string,string>` or a synchronous `FileSystem`, and return `{ mainModule, modules }` plus assets and a manifest for host-side serving ([README][wb-readme], [design][wb-design]).
  - `createFileSystemSnapshot()` bridges from the async Workspace ([README L712-730][wb-readme-fs]).
  - It installs npm dependencies from the registry inside the Worker. Its limits are a flat `node_modules`, text files only (no `.wasm`) and no depth limit ([README L869-876][wb-readme-lim]).
  - The README still says Worker Loader is "closed beta", which is out of date.
- **Type-checking inside workerd.** `createTypescriptLanguageService({ fileSystem })` comes from `@cloudflare/worker-bundler/typescript`. It returns a `languageService` plus a wrapped `fileSystem`, and writes through the wrapper "see updated diagnostics immediately" ([README L757-868][wb-readme-ts]).
  - The TypeScript bundle is about 5 MB. The package depends on `typescript ^6.0.3` and `@typescript/vfs` ([package.json][wb-pkg]).
  - TypeScript is "pre-bundled as a browser-safe artifact so it runs inside the Workers runtime without Node.js APIs" ([CHANGELOG][wb-cl]).
  - The README shows how to snapshot a `Workspace` into its synchronous `FileSystem` for checking.
  - Known gap: it "downloads the TypeScript npm tarball (~23 MB) on every call" to extract the lib `.d.ts` files (~3.7 MB), with "no caching" ([README L869-876][wb-readme-lim]).
  - It is experimental. Nothing I read shows it type-checking a large project, so memory and CPU on our projects are unmeasured.
- **Sandbox SDK and Containers.** Both GA since 2026-04-13 on Paid ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)).
  - Each sandbox is a Firecracker microVM ([concepts](https://developers.cloudflare.com/sandbox/concepts/)), with cold starts "often … 1-3 seconds" ([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)). Billing is per 10 ms while active ([pricing](https://developers.cloudflare.com/containers/pricing/)).
  - Sandbox SDK 1.0 (2026-09-30) removed `gitCheckout`, sessions, `exposePort` and the code interpreter, and dropped the tool-laden default image ([1.0 changes](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/)).
  - Out of scope under the no-containers decision. It is listed so we know what moved.
- **Workers for Platforms.** $25/month with 1,000 scripts included, and a 30 s CPU cap per invocation ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)). User scripts are uploaded with a multipart `PUT` to a dispatch namespace ([examples](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/)). It is only relevant if projects later need durable deployment rather than preview (inferred).

### 5. Prior art

- **cloudflare/vibesdk**, read at [`9da158d`][vibe-sha] (2026-09-07). `main` has moved past the 2025 launch design, which ran code in containers. The docs now call that design "retired" ([docs/llm.md L5-57][vibe-llm]).
  - **Agents.** A `CodeGeneratorAgent` (`Agent`) owns the WebSocket and UI state. It calls a `ThinkAgent` (`extends Think`) over RPC for the model and tool loop, with up to 25 steps per turn ([ThinkAgent.ts L160-164][vibe-think], [L316-383][vibe-think-steps]).
  - **Files.** A per-app `SpaceDO` holds the files in a `@cloudflare/shell` Workspace on DO SQLite, with local git history through `createGit`. An optional backend keeps an in-memory tree checkpointed to SQLite and pushes each commit to an Artifacts repo ([fs-backend.ts][vibe-fs]).
  - **Preview.** No container. `SpaceDO` bundles with `@cloudflare/worker-bundler` (`createApp` when there are assets, otherwise `createWorker`). It loads the bundle with `env.LOADER.get(<space>-<branch>-<commit>)`, runs the exported `App` class as a DO Facet, and serves static assets itself ([deploy-engine.ts L153-231][vibe-deploy], [durable-object.ts L646-760][vibe-do]). Preview URLs are `/space/<id>/preview/<branch>/?t=<signed token>` on the main domain ([think.ts L374-393][vibe-urls]). The loader call sets no `globalOutbound`, so generated code keeps default network access (inferred).
  - **Type-checking: none on the current path.** The build only bundles with esbuild-wasm and sucrase. The model's feedback is build errors and browser console logs. No Worker code imports `typescript` ([deploy-tool.ts][vibe-deploy-tool], [setup.md L450][vibe-setup-450]). vibesdk pins worker-bundler 0.0.4 ([bun.lock L334][vibe-lock]). The in-Worker TypeScript language service arrived in 0.1.0 ([worker-bundler CHANGELOG L152-212][wb-cl]). A grep of the vibesdk checkout for `createTypescriptLanguageService` found nothing. Only the legacy container path ran `bunx tsc -b --noEmit` ([sandboxSdkClient.ts L1571-1700][vibe-tsc]).
  - **Editor.** Monaco with `readOnly: true`, and there is no message type for user edits ([main-content-panel.tsx L365-390][vibe-editor]). An editable pane is ours to build.
  - **Model.** Gemini via the AI Gateway `/compat` endpoint ([model-config.ts][vibe-model]). Think's `workspaceBash` is set to `false` ([ThinkAgent.ts L163-164][vibe-think]).
  - **Auth.** Its own email/password plus Google, GitHub and Cloudflare OAuth. Sessions are HS256 JWT cookies. `ALLOWED_EMAIL` limits sign-in to one address ([authUtils.ts L20-34][vibe-auth]). No Cloudflare Access login.
  - **Export.** GitHub export pushes the real `.git` history ([controller.ts L190-211][vibe-gh]). Deploys go to a Workers for Platforms namespace, or to the user's own account when `ENABLE_USER_ACCOUNT_DEPLOY` is on ([think-user-deploy.ts][vibe-userdeploy]). There is no import on `main`.
  - **Status.** The latest release is v1.5.0 (2026-02-03), so the Think-based architecture looks unreleased (inferred, [CHANGELOG][vibe-cl]). Deploying it still requires Workers for Platforms and a wildcard custom domain ([README L82-88][vibe-readme]).
- **Cloudflare OS** ([cloudflare/cloudflare-os][cfos-sha], [blog 2026-08-05](https://blog.cloudflare.com/cloudflare-os/)). This is the Workers runtime team's open-source browser workspace: chat plus agent-built "gadgets". The README calls it "early access".
  - "Every workspace is its own Durable Object, every Gadget runs in a Dynamic Worker Facet", and "Dynamic Workers, Facets, and several other features were added to the runtime specifically to support Cloudflare OS" ([README][cfos-readme]).
  - Gadget source lives in a real git object store inside the workspace DO. It uses isomorphic-git plumbing over a virtual gitdir that maps loose objects to DO storage records, with no refs and its own commit encoder ([git-store.ts][cfos-git]).
  - The editor is CodeMirror 6 ([workshop-frontend package.json][cfos-fe]).
  - The agent loop is `@earendil-works/pi-agent-core`, not the Agents SDK ([workshop-backend package.json][cfos-be]).
  - Access sits in front, and the backend verifies `cf-access-jwt-assertion` with `jose` `createRemoteJWKSet(<issuer>/cdn-cgi/access/certs)` plus `jwtVerify({ issuer, audience })` ([access.ts][cfos-access]).
  - I found no type-checking in the backend source (grep for `getSemanticDiagnostics` and `createLanguageService` returned nothing).
- **Agents SDK examples**, at `7945da9`:
  - [`workspace-chat`][ex-wschat]: `AIChatAgent`, a `Workspace`, file tools and a live file-browser sidebar. This is the closest skeleton to our chat plus file tree.
  - [`dynamic-workers-playground`][ex-dwp]: a tabbed editor, worker-bundler, Worker Loader, and Tail Worker log streaming into a DO.
  - [`worker-bundler-playground`][ex-wbp]: prompt to TS files to a running Worker.
  - [`sandbox-coding-agent`][ex-sca]: Think orchestrating Claude Code in containers. Containers are out of scope, but its README warns "`/agents/*` has no authentication… Put it behind Cloudflare Access".
- **`agent-think`** ([AGENTS.md][agent-think]). Cloudflare's internal issue-fixing Think agent. It splits a `ThinkAgent` DO (turns) from a `WorkspaceAgent` DO that "exclusively owns Workspace VFS", serves a live thread UI "behind Cloudflare Access", and uses agents state sync for the sidebar.

### 6. LLM access

- **Anthropic direct (our choice).** Nothing in Workers blocks it. HTTP requests and DOs have no wall-clock limit while connected, individual subrequests have "no set time limit", and awaiting I/O "does not count toward CPU time" ([Workers limits][wl]). The Agents limits page lists wall clock per step as "Unlimited", for example while waiting on an LLM response ([Agents limits][agl]). The risks are eviction and deploys (§1, §3.4).
- **AI Gateway** (not chosen). It proxies Anthropic at `…/{gateway_id}/anthropic` ([Anthropic provider](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)). It adds BYOK keys in Secrets Store ([BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)), caching, rate limits and logs. Its request timeout counts to the first chunk only ([request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)). No response-size or stream-duration limit is documented ([limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)). Adding it later would give spend controls and logging (inferred).
- **Workers AI.** The catalog lists 70 models ([models](https://developers.cloudflare.com/workers-ai/models/), updated 2026-08-12).
  - Coding-capable models with function calling include `@cf/moonshotai/kimi-k2.7-code` (262k context), `@cf/zai-org/glm-5.3` (1M context, "flagship agentic coding model"), `@cf/openai/gpt-oss-120b` and DeepSeek V4.
  - Paid-only models are limited to 20 requests/min on standard billing ([Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)).
  - It is the default in the Agents docs and in the `workers-ai-provider` README ([cloudflare/ai](https://github.com/cloudflare/ai/tree/main/packages/workers-ai-provider)). A cheap fallback or sub-agent model, not a replacement for Claude in v1 (inferred).

### 7. Auth: Cloudflare Access

- **Two ways to attach Access.**
  - Worker-level Access (2026-08-14) attaches to the Worker itself, covering routes, custom domains, workers.dev and previews. The Worker reads identity from `ctx.access.getIdentity()` and `ctx.access.aud`, and "No extra configuration or JWT parsing is required" ([Workers + Access][wacc], updated 2026-08-18; [blog](https://blog.cloudflare.com/workers-protected-by-access/)).
  - But "Worker-level Access policies do not currently support WebSocket connections". Upgrades fail with a 403, and the docs point Workers using WebSockets, Durable Objects included, to a hostname-based Access application ([Workers + Access][wacc]).
  - `ctx.access` is also not passed through service bindings or RPC (same page).
- **Validating the JWT** ([validate JWT][jwt]):
  - Read the `Cf-Access-Jwt-Assertion` header. The docs prefer it over the `CF_Authorization` cookie, which "is not guaranteed to be passed".
  - Verify it against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` with the application's AUD tag. The official Workers example uses `jose`.
  - Keys rotate every 6 weeks, and old keys stay valid for 7 days.
- **Claims.** The JWT carries `email`, `sub`, `iss`, `aud`, `exp` and others. Groups appear only when explicitly configured, and the `custom` claim is trimmed above about 1 KB. Use `/cdn-cgi/access/get-identity` for the full identity ([application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)).
- **Entra ID.** It is a supported identity provider, set up with an app registration whose redirect is `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Group support needs `GroupMember.Read.All`. Policies reference groups by Object ID, or by name with SCIM ([Entra ID](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/)).
- **Plans.** The Zero Trust free plan covers 50 users ([plans](https://www.cloudflare.com/plans/sase-zero-trust/)). Any authentication event uses a seat ([seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)). Service tokens don't use seats and suit CI or test traffic ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)).
- **Where to check in the Agents SDK.** Use `onBeforeConnect` and `onBeforeRequest` in `routeAgentRequest` ([routing.md][routing]). Map the verified `email` or `sub` to the project DO name so one user can't address another's agent (inferred).

### 8. Git (later; not in v1)

- **isomorphic-git runs in Workers.**
  - Cloudflare documents it against Artifacts with `isomorphic-git/http/web` over an in-memory FS ([Artifacts isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)).
  - `@cloudflare/shell` ships `createGit(new WorkspaceFileSystem(workspace))` with clone, status, add, commit, log, branch, checkout, fetch, pull, push and diff. `gitTools()` injects auth so "the LLM never sees secrets" ([README][shell-readme]).
  - Computer's git spec warns that a cloned pack is held in DO memory, so a "1 GB repository will hold the parsed pack in DO memory" ([13_git_interface.md](https://github.com/cloudflare/computer/blob/c798c1121b7b57200a3ae10d441a5b7ea0d0c688/docs/13_git_interface.md)). The 128 MB isolate limit therefore caps repo size (inferred).
- **Artifacts (Cloudflare-native git).**
  - Open beta since 2026-10-01, Paid only. Billing starts 2026-10-14: 10k operations a month included, then $0.15 per 1,000, and 1 GB-month included, then $0.50/GB-month ([changelog][art-cl], [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
  - Limits are 1 GB per repo, 32 MB per file and 1 TB per account ([limits](https://developers.cloudflare.com/artifacts/platform/limits/)).
  - The binding offers `create`, `get`, `list`, `import` and `delete`, and repo handles offer `fork`, `createToken`, `log`, `readTree`, `readBlob` and `readFile`. There is no file-write method. Writes go through git push, and push is protocol v1 only ([Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)).
  - `import` takes a public HTTPS remote only ([import guide](https://developers.cloudflare.com/artifacts/guides/import-repositories/)).
  - Workers Builds can deploy from an Artifacts repo ([Artifacts overview](https://developers.cloudflare.com/artifacts/)).
- **Without a git library.** A host's REST API (GitHub Git Data or Azure DevOps Pushes) called from a Worker is an option. No Cloudflare doc covers it (inferred).

## Open questions

1. Does a Worker with the `experimental` compatibility flag deploy on our account? This only matters if we pick `@cloudflare/computer`'s Worker backends. The docs don't say. A 2023 workers-sdk thread shows experimental flags rejected with error 10021.
2. Does Think's `getModel()` work cleanly with `@ai-sdk/anthropic` called directly? The docs only show Workers AI, so test this, including recovery: Anthropic recovery sends a synthetic user message.
3. How heavy is `@cloudflare/worker-bundler/typescript` in practice? Measure peak memory and CPU on a realistic project, check the 1 s startup with lazy import, and find a way to pre-bundle lib `.d.ts` files instead of the 23 MB tarball fetch.
4. Does a hostname-based Access app inject `Cf-Access-Jwt-Assertion` on the WebSocket upgrade request? It probably does, since the upgrade is an HTTP request through Access (inferred), but no doc says so. The `CF_Authorization` cookie is the fallback.
5. Is DO SQLite storage billing live? The pricing page still says it starts "January 7, 2026 (no earlier)" in the future tense.
6. Should the file tree sync to the browser through Workspace `onChange` broadcasts, or through agent `setState`? State is rebroadcast whole on every change, which argues for `onChange` plus RPC reads (inferred). Concurrency between editor saves and agent writes is last-write-wins in Workspace. See [deps-vfs-editor.md](./deps-vfs-editor.md) open question 7.
7. Think's bash snapshots the whole workspace (up to 1,000 files) on every call. Is that acceptable for our project sizes in CPU and memory, or do we cap or disable `workspaceBash`?
8. The Agents limits page (10 MB script, 1 GB state per Agent) disagrees with the newer Workers and DO pages (64 MiB, 10 GB). Which does Cloudflare enforce for Agents?

[agents-sha]: https://github.com/cloudflare/agents/tree/7945da9c6e142119e296984fc9caadec41e182a5
[computer-sha]: https://github.com/cloudflare/computer/tree/c798c1121b7b57200a3ae10d441a5b7ea0d0c688
[cfos-sha]: https://github.com/cloudflare/cloudflare-os/tree/8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf
[wl]: https://developers.cloudflare.com/workers/platform/limits/
[size-cl]: https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/
[dol]: https://developers.cloudflare.com/durable-objects/platform/limits/
[dop]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[dolife]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[agl]: https://developers.cloudflare.com/agents/platform/limits/
[agent-class]: https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/
[state-docs]: https://developers.cloudflare.com/agents/runtime/lifecycle/state/
[sched]: https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/
[fibers]: https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
[chat-docs]: https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/
[think-docs]: https://developers.cloudflare.com/agents/harnesses/think/
[think-tools]: https://developers.cloudflare.com/agents/harnesses/think/tools/
[codemode-docs]: https://developers.cloudflare.com/agents/tools/codemode/
[think-blog]: https://blog.cloudflare.com/project-think/
[week]: https://blog.cloudflare.com/agents-week-in-review/
[art-cl]: https://developers.cloudflare.com/artifacts/platform/changelog/
[wacc]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
[jwt]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
[agents-pkg]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/agents/package.json
[think-pkg]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/think/package.json
[think-readme]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/think/README.md
[think-ws]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/think/src/think.ts#L3757-L3843
[think-bash]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/think/src/tools/workspace.ts#L1148-L1317
[shell-readme]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/shell/README.md
[shell-docs]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/docs/shell/index.md
[ws-design]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/design/workspace.md
[wb-readme]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md
[wb-readme-fs]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md#L712-L730
[wb-readme-lim]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md#L869-L876
[wb-design]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/design/worker-bundler.md
[wb-readme-ts]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md#L757-L868
[wb-pkg]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/package.json
[wb-cl]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/CHANGELOG.md#L152-L212
[rfc-coding]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/design/rfc-coding-agent.md
[routing]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/docs/agents/routing.md
[ex-wschat]: https://github.com/cloudflare/agents/tree/7945da9c6e142119e296984fc9caadec41e182a5/examples/workspace-chat
[ex-dwp]: https://github.com/cloudflare/agents/tree/7945da9c6e142119e296984fc9caadec41e182a5/examples/dynamic-workers-playground
[ex-wbp]: https://github.com/cloudflare/agents/tree/7945da9c6e142119e296984fc9caadec41e182a5/examples/worker-bundler-playground
[ex-sca]: https://github.com/cloudflare/agents/tree/7945da9c6e142119e296984fc9caadec41e182a5/examples/sandbox-coding-agent
[agent-think]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/agent-think/AGENTS.md
[computer-readme]: https://github.com/cloudflare/computer/blob/c798c1121b7b57200a3ae10d441a5b7ea0d0c688/packages/computer/README.md
[cfos-readme]: https://github.com/cloudflare/cloudflare-os/blob/8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf/README.md
[cfos-git]: https://github.com/cloudflare/cloudflare-os/blob/8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf/packages/workshop-backend/src/git-store.ts#L1-L42
[cfos-access]: https://github.com/cloudflare/cloudflare-os/blob/8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf/packages/workshop-backend/src/access.ts
[cfos-fe]: https://github.com/cloudflare/cloudflare-os/blob/8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf/packages/workshop-frontend/package.json
[cfos-be]: https://github.com/cloudflare/cloudflare-os/blob/8cbfb2b67e3da6222e4d7faeade0ff88eb4253bf/packages/workshop-backend/package.json
[vibe-sha]: https://github.com/cloudflare/vibesdk/tree/9da158d82c597a0e8f4bf033cdccd1053fb6fb15
[vibe-llm]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/docs/llm.md#L5-L57
[vibe-think]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/ThinkAgent.ts#L160-L164
[vibe-think-steps]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/ThinkAgent.ts#L316-L383
[vibe-fs]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/fs-backend.ts#L24-L210
[vibe-deploy]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/deploy-engine.ts#L153-L231
[vibe-do]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L646-L760
[vibe-urls]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/core/behaviors/think.ts#L374-L393
[vibe-deploy-tool]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/deploy-tool.ts#L15-L21
[vibe-setup-450]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/docs/setup.md#L450
[vibe-lock]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/bun.lock#L334
[vibe-tsc]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/sandbox/sandboxSdkClient.ts#L1571-L1700
[vibe-editor]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/src/routes/chat/components/main-content-panel.tsx#L365-L390
[vibe-model]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/model-config.ts#L3-L11
[vibe-auth]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/utils/authUtils.ts#L20-L34
[vibe-gh]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/api/controllers/githubExporter/controller.ts#L190-L211
[vibe-userdeploy]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/deployer/think-user-deploy.ts#L178-L217
[vibe-cl]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/CHANGELOG.md#L3
[vibe-readme]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/README.md#L82-L88
