# 07: Build on demand, on save and at the end of each Turn

**Parent:** [spec](../spec.md), user stories 9, 20, 34, 39, 41, 43, 44 and 46 (stage 4)

**What to build:** The Workspace's code is built:
- when the Agent calls `build`;
- when the Developer saves;
- at the end of every Turn, after the Check.

Build errors and warnings appear in the problems list. The Agent gets up to 3 tries in total to clear both the Check and the Build.

**Blocked by:** 06 (Chat with the Agent in Turns).

**Status:** resolved

- [x] The Builder is loaded the first time a Workspace builds, inside the Workspace's Durable Object, behind an interface that would let it move to a separate isolate.
- [x] Builds use the compatibility settings and bindings from the Workspace's `wrangler.jsonc`.
- [x] Each Build first installs Packages if `package.json`'s dependency fields changed since the last install.
- [x] Errors from the Check don't stop a Build. Build errors do.
- [x] A Build whose output still imports a package that couldn't be found fails, with an error naming the package.
- [x] Building the same inputs again reuses the cached Build.
- [x] The `build` tool returns Build errors to the Agent.
- [x] At the end of every Turn, the Build runs after the Check. Errors from either use up the same 3 retries.
- [x] Saving a file starts a Build.
- [x] Build errors and warnings appear in the problems list.
- [x] Each Build's CPU time, elapsed time and memory are logged for the findings.
- [x] A Check after a Build leaves the Workspace's Durable Object in the same isolate, as in the probe's interleaving test (ADR 0010). If it doesn't once the Agent shares the isolate, the Build moves to a Dynamic Worker.

## Tasks

1. Builder in the Workspace's Durable Object, loaded on first use, with the cache.
2. Feed `wrangler.jsonc` settings into the Build.
3. `build` tool, and a Build on save.
4. A Build at the end of each Turn, sharing the Check's retries.
5. Build errors and warnings in the problems list.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-22, agent:** Built, reviewed and tested locally. Not deployed. The live measurements wait for a deploy: each Build's CPU, wall time and memory, and whether the Workspace keeps its isolate.

- **Builder** (`src/builder`):
  - It's the probe's, behind a `Builder` interface the Workspace loads on its first Build, so esbuild starts only then. A Dynamic Worker could implement the same interface (ADR 0010).
  - It keeps its last 4 Builds by the hash of their inputs, enough to go back and forth between two versions. The app host keeps Builds for good from ticket 08.
  - Errors and warnings are structured: a message, plus a Workspace path, 1-based line and column when esbuild gives them.
- **The bundler never installs Packages:** worker-bundler runs its own npm installer for any dependency it can't find under `node_modules/`, which would skip the one-day rule and the one-version rule. The Builder now passes it a `package.json` without `dependencies`, and the Build's hash still covers the real file.
- **`wrangler.jsonc`:** the Build takes its compatibility date and flags and plain-text `vars` from it. Durable Object bindings come with ticket 11.
- **Packages:** each Build installs first if the dependency fields changed, and doesn't retry an install that already failed, as a Check doesn't. A Build fails if its output still imports a missing Package, naming it, and the log lists those Packages for story 9's count.
- **A Check's errors don't stop a Build.**
- **Turns:** every Turn ends with a Check, then a Build. Errors from either use up the same 3 retries, and the platform's message says which failed. `LastTurn` has `buildErrors`.
- **Agent:** the new `build` tool returns the Build's errors and warnings. Its instructions and the Template's `AGENTS.md` say a Build ends each Turn.
- **Builds the Workspace runs itself:** those for the Turn and the `build` tool go through the Workspace's own stub. Each is a call of its own, with its own CPU and wall time in Cloudflare's trace.
- **API:** `POST` and `GET /api/workspaces/:id/build`.
- **Logs:**
  - **Builds:** every Build logs `{event: "build", workspace, by, isolate, ok, cached, errors, warnings, missingPackages, files, wasmMemoryBytes}`. `wasmMemoryBytes` is esbuild's linear memory, from the probe's tracker, now `src/builder/wasm-memory.ts`.
  - **Durations:** `build-request` logs the duration as the platform Worker or the Workspace saw it.
  - **Checks:** they now log `isolate` too, so a Build followed by a Check shows whether the isolate changed.
- **Page:**
  - The problems list has a Build group, with esbuild errors you can open at their place.
  - Saving runs a Check, then a Build, and so does opening the page.
  - The status line shows the Build.
  - The Conversation's retry notice and the Turn's outcome mention the Build.
- **Size:** the platform Worker is now 28.7 MB, 7.8 MB compressed, with esbuild's 14 MB module. Cloudflare's limit is 10 MB compressed, so Tailwind (ticket 09) and the test runner (ticket 13) have about 2.2 MB between them.
- **Tests:** `test/builds.test.ts` (6) through the API, `test/builder.test.ts` (7), and 3 more Turn tests in `test/conversation.test.ts`. 130 tests in all.
- **Reviewed:** by three Claude reviewers (standards, spec, lean) and Codex as a second opinion, twice.
  - **Fixed:**
    - `check` and `build` called in the same step as `bash` could read the files before bash wrote its changes back. They now wait for the step's other tool calls to finish, counted with Think's `beforeToolCall` and `afterToolCall` hooks;
    - the bundler's own installer could fetch Packages from npm;
    - the cache sat in the Workspace rather than the Builder, held one Build, and needed the snapshot twice;
    - Builds in Turns couldn't be timed;
    - Build errors were strings that the page parsed with a regex;
    - missing Packages weren't countable;
    - `build-request` didn't log `ok` or `cached`;
    - "bundle" in the Agent's instructions;
    - ADR 0011 didn't mention the Build;
    - smaller Lean cuts.
  - **Not changed:**
    - **Build on save:** the page starts it after the Check that follows a save, so leaving the page within the 700 ms wait skips it. Ticket 08 should move it to the server, since the Preview has to follow every save.
    - `BuildReport.hash`.
    - The install test that writes `package.json` through Think's store, as the Check tests already do.
    - Bare Node built-in names such as `buffer` pass the missing-import check whatever the flags (from the probe).

**2026-10-23, agent:** Deployed and checked live. The results are in `docs/findings.md` under stage 4; that stage's verdict waits for the Preview.

- **Build times:**
  - A Worker Template Build takes 108–138 ms of CPU once warm, and 437 ms for the first in an isolate.
  - One with `zod` takes about 1 s, and 2.9 s for the first.
  - A Build of unchanged inputs comes from the cache in 80 ms from the browser.
- **Memory:** esbuild's memory reached 46.7 MB, growing a little with each Build.
- **Isolates:** each Workspace's object kept its isolate through every Build, Check and Turn, so Builds stay in the Workspace's Durable Object.
- **Self-call timing:** the self-call gives each Turn's Build its own trace (960 ms of CPU), but the caller's clock barely moves across it. Its duration log line read 156 ms and is removed (not deployed yet; it only affects logs).
