# Findings

The experiment asks whether Workers isolates alone can be where an application is developed (ADR 0001). Each stage gets a verdict: yes, yes with a caveat, or no. Measurements are Cloudflare's own unless marked otherwise.

## Stage 0: ts-rust's WebAssembly module

**Done.** The module is built from ts-rust commit `5879a56` on a Linux build machine by `tools/ts-rust-wasm/build.sh`, and kept in `vendor/ts-rust-wasm`.

- It is 5,103,370 bytes (2.18 MB gzip). That's not the 4.2 MB in ts-rust's README, whose figures are 2,210 commits older than our pin.
- A build takes about 2 min 40 s with 8 GB of memory and 8 CPUs. It never needed swap. Builds are reproducible: three builds from scratch gave the same hash.
- ts-rust's own build script left the build host's home path in the module on a host's first build. Our script works around it.

## Stage 1: the probe

**Verdict: yes, with a caveat.** Checks and Builds of both Templates run in a Durable Object, far inside the pass bar. The caveat is memory. ts-rust and esbuild don't fit in one isolate together, and neither do two ts-rust runs in one request. Cloudflare doesn't report an error when that happens. It quietly replaces the isolate after the request. Checks run in a Dynamic Worker of their own fit, and leave the Durable Object's isolate alone.

### How it was measured

- **Probe:** a throwaway Worker on `workers.dev` behind Access, measured on 2026-10-13, and since deleted. Its Durable Object held two built-in test projects with their Packages:
  - **Worker:** Hono, 577 files, 1.9 MB;
  - **Worker + React:** Hono server, React 19 client, two tsconfigs, 693 files, 11.6 MB.
- **CPU and wall time** come from a Tail Worker that records Cloudflare's trace for each Durable Object call, because in-code timers don't advance during CPU work.
- **Memory:**
  - **What's measured:** the size of each WebAssembly module's linear memory when its instance is replaced or the step ends. Linear memory never shrinks, so that's the step's peak.
  - **What's missing:** workerd doesn't expose the JavaScript heap or compiled code size.
  - **Hitting the limit:** an isolate hitting it shows as a new isolate ID on the next request.
- **Raw data:** deleted with the probe; the tables below keep its numbers. The interleaving runs were ad-hoc scripts, and their output is reproduced below.

### Results

Startup: Cloudflare reported **25–29 ms** of Worker startup time on the six deploys where I recorded it, with both WebAssembly modules (ts-rust 5.1 MB, esbuild 14 MB) in a 33.5 MB Worker. The limit is 1 s.

**Worker Template** (pass bar: a Check under 3 s)

| Step | CPU ms | Wall ms | ts-rust memory | esbuild memory |
| --- | ---: | ---: | ---: | ---: |
| Check, cold isolate | 401 | 413 | 58.4 MB | |
| Check, warm (3 runs) | 148–155 | 158–172 | 58.4 MB | |
| Check with a deliberate error (1 problem, TS2322) | 166 | 175 | 58.9 MB | |
| Build, cold isolate | 403 | 420 | | 12.5 MB |
| Build, warm (2 runs) | 155–158 | 219–221 | | 13.8–14.5 MB |
| Run in a Dynamic Worker (2 requests) | 1 | 89 | | |

**Worker + React Template** (pass bar: a Check under 10 s)

| Step | CPU ms | Wall ms | ts-rust memory | esbuild memory |
| --- | ---: | ---: | ---: | ---: |
| Check, both tsconfigs (4 runs, each in a new isolate) | 312–443 | 323–471 | 73.1 MB | |
| Check with a deliberate error | 443 | 611 | 73.1 MB | |
| Check, server tsconfig only | | | 57.9 MB | |
| Check, browser tsconfig only (with `lib.dom`) | | | 73.1 MB | |
| Build, cold isolate | 579 | 651 | | 24.0 MB |
| Build, warm (2 runs) | 417–474 | 499–538 | | 34.5–43.0 MB |
| Run: page and client bundle from the host, API from a Dynamic Worker | 9 | 57 | | |

- **Pass bar:** the slowest Check measured was 443 ms of CPU, against 3 s for the Worker Template and 10 s for the React Template. No step crashed, ran out of stack or was reported as exceeding a limit.
- **Facets:** a Durable Object class from a Dynamic Worker runs as a facet with its own storage, both locally and deployed.

### The memory caveat

The isolate ID showed when Cloudflare replaced the probe's isolate:

| In one isolate | What happened |
| --- | --- |
| Worker Checks, then Builds, then a run | One isolate throughout |
| React Builds, three in a row (esbuild grew to 43 MB) | One isolate throughout |
| One React tsconfig per Check, four Checks in a row | One isolate throughout, for each tsconfig |
| Both React tsconfigs in one Check | A new isolate after every Check |
| Any Check after a Build, for either Template | A new isolate after the Check |
| Builds and runs, with every Check in a Dynamic Worker (15 steps, both Templates) | One isolate throughout |

- **Inference:** ts-rust's 58–73 MB of linear memory per run, plus esbuild's 12–43 MB, plus compiled code and the JavaScript heap, goes over the 128 MB limit. The first ts-rust instance isn't freed before a second run in the same request starts.
- **No error:** every request in these runs returned 200, and Cloudflare reported each outcome as `ok`.
- **Cost:** the next request then starts a new isolate, which costs 300 ms to 1 s. For a Workspace's Durable Object it would also drop whatever the isolate held in memory, such as the Agent's state.
- **Decided:** Checks run in a Dynamic Worker ([ADR 0010](adr/0010-checks-run-in-a-dynamic-worker.md)).
- **With Checks in a Dynamic Worker:** the Durable Object sends only the files a Check reads, one RPC call per tsconfig, and passes ts-rust's compiled module as a wasm module. A React Check then took about 350 ms end to end on the client, including sending 237 files.

### Found along the way

- **The vitest plugin:** `@cloudflare/vitest-plugin` 1.4.0 fails every test under vitest 5.0.4 on Windows ("File path must be a file: URL"), although it declares vitest 5 support. vitest 4.1.11 works.
- **Old code after a deploy:** a running Durable Object kept the previous version's code for several minutes after a deploy, while the Worker in front of it ran the new code. A call to a method that only the new code had failed with "The RPC receiver does not implement the method".
- **es-module-lexer 3:** it renamed an import's `n` field to `specifier`. Code written for version 2 silently sees no imports.
- **worker-bundler:** its build errors name files `virtual:<path>`.
- **Clocks:** `Date` at a Worker's top level reads 1970-01-01, and randomness isn't allowed there. Anything per-isolate has to be set on the first request.
- **Timing:** Cloudflare's trace CPU time is the only reliable timing for CPU-bound work. In-code timers don't move until the next I/O.

## Stage 2: editing with live Checks

**Verdict: yes.** On the deployed platform, a Check of a fresh Worker Template Workspace takes about a quarter of a second from the browser, and under 0.6 s when it's the first Check after a deploy. The pass bar is 3 s. A saved type error is underlined about 1 s after Save, most of which is the page's own 700 ms wait for more saves.

### How it was measured

- **Platform:** the deployed platform, measured on 2026-10-22 from the Developer's signed-in browser in the UK.
- **Workspace:** a new one made from the Worker Template, with `hono` installed. Each Check sent the Dynamic Worker 198 files: the Workspace's own and `hono`'s declarations.
- **Times:**
  - **Browser** (not Cloudflare's): the browser's Resource Timing for each `POST /api/workspaces/:id/check`.
  - **Platform Worker:** the wall time of the same request in the platform Worker, from Cloudflare's trace (`wrangler tail`). It leaves out the network between the browser and Cloudflare.
- **What couldn't be used:**
  - **In-code timers:** the Workspace's own timers read 0 ms for every warm Check. A call into a Dynamic Worker doesn't count as I/O, so the clock doesn't move across it (see Stage 1, Found along the way). Only the platform Worker, which calls the Workspace over the network, can time a Check. It now logs one `check` event per Check, with that time.
  - **The Workspace's trace times:** its CPU time was 4–10 ms per Check. ts-rust's work happens in the Dynamic Worker, and that isn't in the platform's trace. Its wall time ran on until the Workspace's next request, up to 58 s for the last Check of a run.

### Results

**Worker Template** (pass bar: a Check under 3 s)

| Check | Browser ms | Platform Worker ms |
| --- | ---: | ---: |
| First after the deploy, run by opening the Workspace page | 587 | 556 |
| Warm, 10 in a row | 195–865, median 230 | 202–233 (the 3 in the trace) |
| With a saved type error (1 problem, TS2322) | 260 | 209 |
| Warm, after adding `zod` (456 files sent, 5 in a row) | 232–311 | 199–274 |

- **Save to underline:** 1,077 ms after Save, in the browser. The save took 94 ms, the page waits 700 ms after the last save, and the Check took 260 ms.
- **Other steps:**
  - creating the Workspace, `hono` install included: 1.7 s;
  - adding `zod`: 1.2 s;
  - opening a file: 132 ms in the platform Worker.
- **Pass bar:** the slowest Worker Template Check was 865 ms, against 3 s. Two of the ten warm Checks took 410 and 865 ms in the browser. Neither is in the trace, so where their extra time went isn't known.
- **The trace is incomplete:** `wrangler tail` delivered only some of the requests, so the platform Worker column has fewer runs than the browser one.

### Found along the way

- **"Checked in 0 ms":** the first deploy showed the Workspace's own timer on the page. The page now shows how long it waited for the Check, and the platform Worker logs that time.
- **Locally, the clock moves:** under `wrangler dev`, the same Checks took 151–511 ms by the Workspace's own timer. Timings taken locally and deployed aren't measured the same way.

## Stage 3: the Agent and the Check loop

**Verdict: yes.** Every Turn on the deployed platform ended with a clean Check: seven Turns of Opus 5.5 on a Worker Template Workspace. One needed a retry, and the platform's Check at the end of the Turn caught an error the Agent had missed. Turns took 6–41 s from Send to the end of the Turn and cost $0.03–0.11 each, because Anthropic's prompt cache served 65–97% of the input tokens.

### How it was measured

- **Platform:** the deployed platform, measured on 2026-10-22 from the Developer's signed-in browser. The model was `claude-opus-5-5` on the Anthropic API with effort `high` and the Turn's 40-step limit.
- **Versions:** the run went through three deployed versions, because it turned up two bugs, described below. The table covers Workspace B, which ran on the last two.
- **Measurements:**
  - **Browser** (not Cloudflare's): from clicking Send to the page showing the Turn had ended.
  - **Turn log:** the Workspace's own `turn` line, from the Turn starting to its last model call.
  - **Tokens:** Anthropic's usage figures, summed over the Turn's model calls.
  - **Cost:** estimated from those figures at $4 per million input tokens, $5 for cache writes, $0.20 for cache reads and $20 for output.
- **Each Turn:** sent through the Conversation panel. The Agent's file changes and the problems list were read back from the page.

### Results

**Workspace B** (Worker Template)

| Turn | Asked for | Browser | Turn log | Steps | Retries | Input tokens (cache read / written) | Output | Cost |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| A | A `GET /api/time` route | 6.6 s | 5.9 s | 3 | 0 | 12.2K (7.9K / 4.3K) | 0.3K | $0.03 |
| B | A to-do API in its own file, validated with zod | 30.6 s | 28.5 s | 9 | 1 | 55.9K (52.4K / 3.5K) | 2.0K | $0.07 |
| C | A generic `groupBy`, Hono's validator, and an `AppType` export | 40.5 s | 37.9 s | 4 | 0 | 43.6K (38.5K / 5.1K) | 3.9K | $0.11 |
| D | Fix a type error the Developer saved | 12.2 s | 11.0 s | 4 | 0 | 55.9K (54.4K / 1.5K) | 0.6K | $0.03 |
| E | After Start fresh: a `DELETE` route | 13.8 s | 12.6 s | 4 | 0 | 22.9K (16.6K / 6.3K) | 0.7K | $0.05 |

- **Workspace A,** on the first version, ran the first two asks clean in 9.4 s and 18.1 s from the browser. Their Turn logs were lost (see below).
- **What the Agent did:**
  - It used every kind of tool: the file tools, bash (`cat`, `ls`, `grep`, `sed`, `head`), `add_package` (for `zod` 4.6.7) and `check`.
  - In Turn D it was told which file the Developer had changed, read that file first, and kept the Developer's export as asked.
- **The retry in Turn B:**
  - The Agent's own Check said 0 errors, because it raced the Agent's edits (see below).
  - The end-of-Turn Check found 1 error, and the platform asked the Agent to fix it.
  - The Agent fixed it in the retry, and the next Check was clean.
- **Start fresh:**
  - It took 12 s, including the model writing the summary.
  - The summary kept what the Agent needed: in Turn E the Agent went straight to the right file and kept Turn C's route chaining.
  - The next Turn's input fell from 55.9K tokens to 22.9K.
- **Cost:**
  - The whole run cost about $0.50, against a budget of $15.
  - The cache served 65% of the input tokens in Turn A, where the prompt was new, and up to 97% later.
- **Errors:** no exceptions were logged.

### Found along the way

- **A Turn's logs never arrived:** a Turn run in the background of the call that started it kept that invocation open, so neither its Check lines nor its `turn` line ever reached Workers Logs. Each Turn now runs in an alarm of its own, which ends when the Turn does ([ADR 0011](adr/0011-the-platform-runs-each-turn.md)).
- **The Agent's Check raced its own edits:**
  - Opus often calls `edit` and `check` in the same step, and a step's tool calls run side by side, so `check` read the files before the edit landed.
  - The Agent noticed ("the first Check right after my edit still showed the old error"), and in Turn B it stopped early because of it.
  - The `check` tool now yields to the event loop first, so the file tools in the same step finish before it reads the files.
- **The Agent can't read Packages:**
  - Packages live outside Think's file store, so the file tools and bash can't see `node_modules`.
  - In Turn C the Agent wanted Hono's validator types and wrote "I couldn't open Hono's source here".
  - Read-only access to Package declarations would help.
- **Timers don't move the clock either:** timed after a 1 ms timer, a Check inside the Workspace read 4–10 ms, while the platform Worker measured 340 ms for the same Check. Only the platform Worker can time a Check. A Turn's own log leaves out the Check at its end, which is why it reads 0.6–2.6 s below the browser.
- **Tail connections drop on a deploy:** `wrangler tail` lost its connection twice, once after each redeploy, and reconnected by itself.

## Stage 4: Builds and the Preview

**Verdict:** waits for the Preview (ticket 08). **Builds so far:** they fit.
- A Worker Template Build takes 108–138 ms of CPU once warm.
- One that bundles zod takes about 1 s.
- The Workspace's Durable Object kept its isolate through Builds, Checks and Turns, with esbuild's memory at up to 46.7 MB beside the Agent.

### How Builds were measured

- **Platform:** the deployed platform, measured on 2026-10-23 from the Developer's signed-in browser.
- **Size:**
  - With esbuild's 14 MB module, the Worker is 28.7 MB, 7.8 MB compressed, against Cloudflare's 10 MB limit.
  - Cloudflare reported a startup time of 114 ms, against a 1 s limit.
- **Times and memory:**
  - **CPU and wall time:** from Cloudflare's trace of each Workspace `build` call (`wrangler tail`).
  - **Request time:** `build-request` is the time a Developer's Build took as the platform Worker saw it.
  - **Browser** (not Cloudflare's): the round trip of `POST /api/workspaces/:id/build`.
  - **Memory:** esbuild's linear memory, from the Workspace's own tracker.
- **Isolate:** each Workspace's log lines name the isolate they ran in. The name is chosen on first use, so a new name means Cloudflare replaced the isolate.
- **Two Workspaces:**
  - **Stage 4 Builds:** a fresh Worker Template Workspace, 578 files with `hono`.
  - **Workspace B:** from stage 3, 1,086 files, with `zod` and the to-do API. Its first Build ran when the Developer signed in and the page they had open reloaded.

### Results

**Stage 4 Builds** (Worker Template)

| Build | CPU ms | Wall ms | Request | Browser | esbuild memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| First in the isolate | 437 | | 550 ms | 615 ms | 13.1 MB |
| Warm, after an edit (6) | 108–138 | 194–228 | 146–172 ms | 176–225 ms | 14.9 MB |
| Same inputs again (cached) | 15 | | | 80 ms | 16.3 MB |

**Workspace B** (Worker Template with `zod`)

| Build | CPU ms | Wall ms | Request | Browser | esbuild memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| First in the isolate | 2,909 | 2,968 | 2,984 ms | | 37.5 MB |
| Warm, after an edit (3) | 949–1,258 | 1,097–1,139 | 1,048–1,346 ms | 1,088–1,386 ms | 44.6–45.6 MB |
| At the end of a Turn | 960 | 1,036 | | | 46.7 MB |
| The Agent's `build` tool (cached) | 97 | | | | 46.7 MB |

- **Checks between the Builds:** 4–15 ms of the Workspace's CPU, and 158–435 ms as the platform Worker saw them. The Check's own work runs in its Dynamic Worker.
- **The isolate stayed the same:**
  - Workspace B's object kept one isolate from 10:33 to 10:38, through 7 Builds, 5 Checks and 2 Turns of Opus 5.5. In those Turns the model's work, Think and esbuild all shared it.
  - The Stage 4 Workspace kept one isolate through 7 Builds and 6 Checks.
  - So ADR 0010's fallback, moving Builds to a Dynamic Worker, isn't needed yet.
- **The Turns:** both ended with a clean Check and Build.
  - One added a route in 12.6 s from the browser, 3 steps, with the Build 960 ms of CPU.
  - One ran the `build` tool in 3.5 s, 2 steps.

### Found along the way

- **zod makes Builds about 8 times slower:** about 1 s of CPU against 120 ms. The first Build in a fresh isolate took 2.9 s.
- **esbuild's memory only grows:** it went from 37.5 MB to 46.7 MB over six Builds in Workspace B. Linear memory never shrinks, and the Agent shares the isolate. It's worth watching once the React Template builds a client too.
- **The bundler would install Packages itself:** worker-bundler runs its own npm installer for any dependency it doesn't find under `node_modules/`, which would have skipped the one-day rule. It was caught in review before the deploy; the Builder no longer tells the bundler about dependencies.
- **Calling the Workspace's own stub:**
  - It gives each Build the Workspace runs itself (for a Turn or the Agent) a trace of its own.
  - The caller's clock barely moves across the call: 156 ms for a Build the trace put at 1,036 ms.
  - The work after the call runs inside it, so the Agent's Build event also counts the Turn's work that followed: 1.8 s of wall time for a cached Build.
- **Room left:** 2.2 MB of the 10 MB compressed limit for Tailwind (ticket 09) and the test runner (ticket 13).
