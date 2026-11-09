# Findings

The experiment asks whether Workers isolates alone can be where an application is developed (ADR 0001). Each stage gets a verdict: yes, yes with a caveat, or no. Measurements are Cloudflare's own unless marked otherwise.

## Conclusion

**Yes: Workers isolates alone can be where a Workers app is developed, for apps of the kind the two Templates make, with a narrower toolchain than a laptop's.** Every stage passed: stage 1 on a probe, with a caveat, and stages 2–6 on the deployed platform, stages 4–6 in Chrome.
- **Editing with Checks (stages 1 and 2):** ts-rust, a TypeScript checker compiled to WebAssembly, runs in a Dynamic Worker. A warm Worker Template Check takes about a quarter of a second from the browser.
- **The Agent (stage 3):** Turns of Opus 5.5 end with a clean Check, retrying when one has errors, and cost $0.03–0.15 each, thanks to Anthropic's prompt cache.
- **Builds and the Preview (stage 4):** esbuild builds both Templates, with Tailwind compiled by the platform, and the Preview runs each Build for the Developer and the Agent. A React Build takes under 1 s from the browser once warm.
- **Hosting (stage 5):** a Deployment serves a published Build, with Durable Objects for data and secrets in `env`.
- **Tests (stage 6):** vitest-style tests run in Dynamic Workers, for the Developer, the Agent and at the end of each Turn: 0.6–1.6 s from the browser once warm, and 2.6–3.6 s for the first run after a deploy.

**The caveats:**
- **Memory is the main constraint.** An isolate has 128 MB. A ts-rust run takes 58–73 MB, and esbuild never gives its memory back. So Checks, the tests' bundling and Builds run in Dynamic Workers of their own. In the Durable Object, a Check after a Build or with both React tsconfigs went over the limit (stage 1), the React Template's third test run did (stage 6), and so did every Build of a large app (#87). What an app can build is limited by the Packages it bundles: a small app with a UI kit's Packages took esbuild near the limit by itself (#99).
- **The toolchain is narrower.** There's no Vite or Node: the platform reproduces what a project's config would do, compiles Tailwind without plugins, and tests without a DOM, module mocks or snapshots.
- **Apps get Durable Objects and nothing else** for storage (ADR 0006).
- **Apps can't run on a schedule yet.** Their Durable Objects are facets, whose alarms never ring, deployed or locally. Locally, the app host could keep their alarms for them (#107).
- **Apps can't have live updates over WebSockets yet.** An upgrade reaches an app's Durable Object, but the platform's RPC hop can't carry the socket back, locally and deployed. Locally, sending upgrades over `fetch` instead works, with hibernation (#109).
- **Only Chrome was checked,** from stage 4 on. Firefox and WebKit are still to check.

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

- **The vitest plugin:** `@cloudflare/vitest-plugin` 1.4.0 fails every test under vitest 5.0.4 on Windows ("File path must be a file: URL"), although it declares vitest 5 support. vitest 4.1.11 works. On Linux, 1.4.0 fails under vitest 5.0.5 too ("no such file or directory, readAll" in `node_modules/.vitest-cache`). 1.4.7 passes locally but, on GitHub's 2-core, 8 GB runner, its workers exit during `builds.test.ts` and `files.test.ts`, even one test file at a time. vitest 4.1.11 passes there (ticket 16).
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

**Verdict: yes, for both Templates, in Chrome.** Builds fit, and the Preview works on the deployed platform, in the pane and in a tab, and for the Agent (below, "Stage 4, continued: the Preview"). The Worker + React Template builds a React page styled with Tailwind, and its Builds take about as long with Tailwind as without (below, "Stage 4, continued: the Worker + React Template"). Firefox and WebKit are still to check. **Builds:**
- A Worker Template Build takes 108–138 ms of CPU once warm.
- One that bundles zod takes about 1 s.
- A Worker + React Template Build takes 730–930 ms from the browser once warm, with or without Tailwind.
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
- **Room left:** 2.2 MB of the 10 MB compressed limit for Tailwind (ticket 09) and the test runner (ticket 13). After ticket 09, about 2.2 MB is left for ticket 13 (below).

## A second Installation

**The platform moved and got no slower.** It was deployed from CI to a new Installation on a Workers Paid account (ticket 17), with apps on a domain of their own ([ADR 0012](adr/0012-apps-live-on-a-domain-of-their-own.md)). A Workspace, Checks, Builds and a Turn of Opus 5.5 all ran as fast as before or faster, and no exceptions were logged.

### How it was measured

- **Platform:** the deployed platform, measured on 2026-10-26 from the Developer's signed-in browser in the UK, on the first deploy from `main`.
- **Times:** taken the same way as before.
  - **Browser:** each API call's round trip, timed in the page.
  - **Platform Worker:** for Checks, the platform Worker's wall time from Cloudflare's trace, as in stage 2. For Builds, its `build-request` time, as in stage 4.
  - **CPU:** the Workspace's CPU from the trace. A Check's own work runs in its Dynamic Worker (stage 2).
- **Workspace:** a fresh one made from the Worker Template, with `hono`.

### Results

| Step | Browser | Platform Worker | Workspace CPU ms | Before |
| --- | ---: | ---: | ---: | --- |
| Create the Workspace, `hono` install included | 983 ms | | | 1.7 s |
| First Check | 503 ms | 458 ms | 14 | 587 ms browser, 556 ms platform |
| Warm Check (3) | 158–210 ms | 130–162 ms | 3–7 | median 230 ms browser, 202–233 ms platform |
| First Build in the isolate | 440 ms | 404 ms | 373 | 615 ms browser, 437 ms CPU |
| Build after an edit (3) | 185–219 ms | 143–184 ms | 105–145 (2 in the trace) | 176–225 ms browser, 108–138 ms CPU |
| Same inputs again (cached) | 75 ms | 24 ms | 10 | 80 ms browser |

**The Turn:** the same ask as stage 3's Turn A, "Add a `GET /api/time` route that returns the current time as JSON", against a budget of $1.

| | Browser | Turn log | Steps | Retries | Input tokens (cache read / written) | Output | Cost |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| Now | 6.2 s | 5.8 s | 3 | 0 | 13.0K (8.4K / 4.5K) | 0.3K | $0.03 |
| Stage 3, Turn A | 6.6 s | 5.9 s | 3 | 0 | 12.2K (7.9K / 4.3K) | 0.3K | $0.03 |

- **What the Agent did:** it read `src/index.ts` and added the route. The Turn ended with a clean Check and a clean Build.
- **The isolate:** the Workspace's Durable Object kept one isolate through the Checks, the Builds and the Turn.

### Found along the way

- **Access's cookie:** on the platform, `CF_Authorization` came back host-only, `Secure` and `SameSite=Lax`, the last as the set-up asked (ADR 0012).
  - It wasn't `HttpOnly`, so the page's own scripts could read the token. Nothing on the platform's pages needs to, so the set-up now asks for `HttpOnly` too.
  - This answers the research's open question 3 (`docs/research/run-and-host.md`). The cookie is host-only, and Access leaves `HttpOnly` off unless the application turns it on.
- **New hostnames and DNS caches:** a resolver that looked up a hostname before its record existed went on answering "no such name" until its negative cache ran out. For `jigworks.dev`, the SOA's TTL and minimum are both 30 minutes, so that can take up to 30 minutes. One ISP resolver took about 7 minutes to see `app.jigworks.dev` after the first deploy created it.

## Stage 4, continued: the Preview

### Which Access application covers a Preview

Previews sign their Developer in themselves (ADR 0013), so Access must let Preview hostnames through. A Bypass application on `*-preview.jigworks.app` sits beside the Allow application on `*.jigworks.app`, and Cloudflare doesn't document which wins. Measured on 2026-10-30 with `curl`, before the apps route was deployed:

| Hostname | Answer |
| --- | --- |
| `anything-preview.jigworks.app`, `notes-k3x9p2qa-preview.jigworks.app`, `a-b-c-preview.jigworks.app` | past Access (522: no route yet) |
| `anything.jigworks.app`, `notes-k3x9p2qa.jigworks.app` | Access sign-in |
| `preview.jigworks.app`, `x-preview-y.jigworks.app` | Access sign-in |

So the more specific hostname wins, as it does for paths, and only hostnames whose first label ends in `-preview` get past Access.

### The live check

**The Preview works in Chrome as ADR 0013 planned, in the pane and in a tab, and the Agent tried its own change on it.** Firefox and WebKit weren't checked.

- **Platform:** the deployed platform, measured on 2026-10-30 after ticket 08's deploy, from the Developer's signed-in browser (Chrome) in the UK.
- **Times:** each taken in the page, from the request or click to the response or the frame's `load` event. The trace's figures are each invocation's own.
- **Workspace:** a fresh one made from the Worker Template.

| Step | Browser |
| --- | ---: |
| First Build, its round trip (the Preview reported ready straight after) | 986 ms |
| Preview tab chosen, to the frame's first page (cold) | 1.1 s: 104 ms for the link, 992 ms for the Preview to swap the link for a session and load the page |
| Pane shown again, after the Editor tab | 669 ms |
| A save, to the successful Build it starts by itself | under 0.8 s |

- **Access:** after the deploy, `anything-preview.jigworks.app` reached the platform, and `anything.`, `preview.` and `x-preview-y.jigworks.app` still went to Access sign-in.
- **Cookies in the pane:** the app never saw the session cookie. Its own `__Host-app` cookie, which the platform made partitioned, came back on the next load. The page's scripts could read neither.
- **Logs:** the app's `console.log` lines and an uncaught front-end error both reached the pane's Logs. The error's report goes with the frame's partitioned session cookie, so Chrome kept that cookie.
- **A hidden pane:** there was no frame while the Editor tab was chosen. Shown again, the pane signed in with a fresh link.
- **A tab:** Open in a new tab, and `/preview-sign-in` with a path and query, both landed on the Preview, at that path, signed in with a `Lax` session that worked for other paths. Every page carried `frame-ancestors 'self' https://app.jigworks.dev`. A private window with no session went to the platform's Access sign-in, set to come back to the same path.
- **Deleting the Workspace:** afterwards, the tab, with its session not yet expired, got `404 There's no app here.`

**The Turn:** "Add a `GET /api/time` route that returns the current time as JSON, then try it on the Preview", against a budget of $1. The browser didn't time it.

| Turn log | Steps | Retries | Input tokens (cache read / written) | Output | Cost |
| ---: | ---: | ---: | --- | ---: | ---: |
| 11.7 s | 4 | 0 | 20.7K (15.2K / 5.5K) | 0.4K | $0.04 |

- **What the Agent did:** it read `src/index.ts`, added the route, called `build`, then called `request_preview` on `/api/time`. It got a 200, reported the JSON it got, and the Turn ended with a clean Check and a cached Build.
- **The trace:**
  - The Agent's Build was the first in a fresh isolate. It reached the app host 1.6 s after it started. Its trace event, 5.4 s wall and 1,015 ms CPU, also counts the rest of the Turn, as in stage 4.
  - `receiveBuild` took 382 ms in the app host.
  - `request_preview`, the Build's first request on its Dynamic Worker, took 48 ms in the app host.

### Found along the way

- **A secret change didn't reach a running Workspace.** Three Turns failed with `invalid x-api-key`, costing nothing.
  - The first failed because the key was wrong.
  - It was replaced with `wrangler secret put`, but the next two Turns failed the same way. The Workspace's Durable Object went on running the version from before the change, with the old key, for nearly five minutes, until a redeploy.
  - Its log lines name one isolate from 18:46 to 18:54, so it never restarted. The platform Worker's first request after the change, 17 s later, already ran the new version.
  - `docs/development.md` now says to redeploy after changing the key.

## Stage 4, continued: the Worker + React Template

**A Workspace made from the Worker + React Template, with React 19.3.1 and its types installed from npm, had a clean Check, built, and showed a styled React page in the Preview.** The Agent styled it further with Tailwind 4's CSS-first setup, which the platform compiled. Firefox and WebKit weren't checked.

- **Platform:** the deployed platform, measured on 2026-10-30 after ticket 09's deploy, from the Developer's signed-in browser (Chrome) in the UK.
- **Times:**
  - **Browser:** each API call's round trip, timed in the page.
  - **Request:** the time the platform Worker saw, from its `check-request` and `build-request` lines, as in stage 4.
  - **CPU:** the Workspace's, from Cloudflare's trace. A Check's own work runs in its Dynamic Worker (stage 2).
- **Memory:** esbuild's linear memory, from the Workspace's own tracker.
- **Workspace:** a fresh one from the Worker + React Template.
- **Plain CSS:** for the second set of warm Builds, `src/styles.css` was replaced with CSS that doesn't import Tailwind, so the Build skipped Tailwind. The Template's files were put back before the Turn.

| Step | Browser | Request | Workspace CPU | esbuild memory |
| --- | ---: | ---: | ---: | ---: |
| Create the Workspace, 7 Packages installed from npm | 2.8 s | | | |
| First Check, both tsconfigs | 1.0 s | 974 ms | 37 ms | |
| First Build in the isolate | 2.9 s | 2,817 ms | 1,756 ms | 25.2 MB |
| Warm Build after an edit, Tailwind (3) | 732–930 ms | 696–891 ms | | 28.3–32.5 MB |
| Warm Build after an edit, plain CSS (3) | 728–895 ms | 660–849 ms | | 32.5 MB |

- **The page:**
  - React rendered, asked the Worker for "Hello, React", and counted clicks.
  - Every class applied as Tailwind defines it. The heading was 36px, bold and slate-900; the button sky-600, with an 8px radius; the column a flex box 576px wide; and the body slate-50, with Tailwind's reset.
  - The CSS was 7.2 KB, and the front end's script, with React's production build, 224 KB.
- **Tailwind's cost:**
  - Warm Builds took about as long with Tailwind as with plain CSS: 696–891 ms against 660–849 ms, as the platform Worker saw them.
  - The trace can't say more. It missed some of the Workspace's events in both sets, so their CPU can't be compared.
  - The Build's class-name scanner gave Tailwind 229 possible class names for the Template, against the 23 classes its page uses, and 392 after the Turn. Tailwind skips the ones it doesn't know.
- **The isolate:** one isolate ran the install, every Check, every Build and the Turn. esbuild's memory grew from 25.2 MB to 32.5 MB over the first four of the Developer's Builds, then held through the rest, the Turn's included.

**The Turn:** "Add a dark mode toggle: a button at the top right of the page that switches between light and dark colours using Tailwind's `dark:` variant, and remembers the choice in `localStorage`", against a budget of $1. The browser didn't time it.

| Turn log | Steps | Retries | Input tokens (cache read / written) | Output | Cost |
| ---: | ---: | ---: | --- | ---: | ---: |
| 27.5 s | 7 | 0 | 66.7K (50.1K / 16.5K) | 2.7K | $0.15 |

- **What the Agent did:**
  - It added `@custom-variant dark (&:where(.dark, .dark *));` to `src/styles.css`, Tailwind 4's way to switch dark mode with a class.
  - It added a `ThemeToggle` component, and a script in `index.html` that sets the class before the page paints.
  - It ran `check`, `build` and `request_preview` itself, and the Turn ended with a clean Check and a cached Build.
- **In the Preview:** the toggle sat fixed at the top right. Clicking it turned the body slate-900 and the heading slate-100, and the choice survived a reload. No server logs or front-end errors were recorded.

### Found along the way

- **Size:** with Tailwind and the Worker + React Template, the Worker is 7,941 KiB compressed, 107 KiB more than before.
  - The Templates' Workers runtime types, 608 KiB, are now packed once, which saved 112 KiB compressed.
  - Ticket 13 has about 2.2 MB of the 10 MB limit.
- **Binary assets:** a Build served `public/` as text, so a binary file there was served damaged (ADR 0014, #31), until #110.

## Stage 5: Hosting (Deployments)

**Verdict: yes, in Chrome.** Publishing, app data and app secrets all work on the deployed platform. Firefox and WebKit weren't checked.
- **Publishing works.** Publish copied a Build to the Deployment in under 100 ms on Cloudflare's side. After its first page, the Deployment's pages took 34–38 ms in the platform Worker, and later Builds changed only the Preview.
- **App data works.** An app's Durable Object instances kept their data across new Builds and publishes, and the Preview's data stayed apart from the Deployment's. Calls through the binding took 17–44 ms on Cloudflare's side, for the 9 calls in the trace.
- **App secrets work.** A secret reached the app's `env` in the Preview and the Deployment. A change reached both on their next request, with no new Build, and so did a removal in the Deployment, the only one checked. Saving one took 40–79 ms in the platform Worker. The Agent never saw the value: only the name, and `[secret API_KEY]` where the app answered or logged with it.
- **Known limits, by design.** These come from the ADRs and earlier stages, not from this stage's checks, and don't qualify the verdict:
  - **Storage (ADR 0006):** apps get no KV, D1, R2, queues or cron triggers. Durable Objects are their only storage.
  - **Durable Objects (ADR 0015):** apps get no WebSockets into an instance and no alarms in one, and `env` imported from `cloudflare:workers` doesn't carry a binding.
  - **Secrets (ADR 0016):** hiding values keeps them out of the Agent's sight, not out of its reach. It writes the app's code, so code that encodes a value or sends it elsewhere can still get it out.
  - **Assets:** binary files in `public/` were served damaged (ADR 0014, #31), until #110.

### Publishing a Deployment (ticket 10)

- **Platform:** the deployed platform, measured on 2026-10-30 after ticket 10's deploy, from the Developer's signed-in browser (Chrome) in the UK.
- **Times:**
  - **Browser:** timed in the page. For the first Publish, from the click to the page showing the Deployment: the button looks at the Deployment again (`GET`), then publishes (`POST`). For the second, from confirming in the dialog, so the `POST` alone.
  - **Platform Worker:** its wall time for the request, from Cloudflare's trace, leaving out the network. For Publish, the `POST`; the `GET` before it took 42–49 ms. The trace missed the first Publish's `POST`.
  - **App host:** the app host's wall time from its Durable Object's trace: its `publish` call, with CPU, or the request passed to it. These figures can run on (`docs/development.md`).
- **Workspace:** a fresh one from the Worker + React Template.

| Step | Browser | Platform Worker | App host |
| --- | ---: | ---: | ---: |
| First Publish | 258 ms | | 54 ms, 2 ms of CPU |
| Publish again | 153 ms, from confirming | 87 ms | 17 ms, 3 ms of CPU |
| The Deployment's page, the first request to it | | 376 ms | 3 ms |
| The rest (3), including the first after publishing again | | 34–38 ms | 0–18 ms |
| Its API, through its Dynamic Worker (4) | | 25–42 ms | 1–14 ms |

- **The first page:** 373 of its 376 ms were spent outside the app host. The trace doesn't say where.
- **Opening it:**
  - The Developer's existing Access session let them into the Deployment without signing in again.
  - With no session, `curl` was sent to Access's sign-in.
- **What it served:**
  - The React page, styled, and its API.
  - Its pages carried `frame-ancestors 'self'` and none of the Preview's error reporting, and a `POST` to `/__jigworks/errors` got 404.
  - Page scripts could read no cookies.
  - A `POST` from its own page reached the app, which answered 404 as it has no `POST` route: the platform didn't refuse it.
  - Unchanged assets were answered 304.
- **Later Builds:** the Developer changed the page's heading to "version 2" and published, then to "version 3" and built. The Preview showed "version 3"; the Deployment stayed on "version 2", and its script still came back 304.
- **Publishing again:** it asked first, naming the Deployment's hostname and when the Build it would replace was published.
- **Deleting the Workspace:** the Deployment's hostname then answered `404 There's no app here.`

### App data (ticket 11)

- **Platform:** the deployed platform, measured on 2026-10-30 after ticket 11's deploy, from the Developer's signed-in browser (Chrome) in the UK.
- **Times:**
  - **Browser:** each request's round trip, timed in the page.
  - **Platform Worker:** its wall time for the request, from Cloudflare's trace, leaving out the network.
  - **`AppData`:** the wall time of a call through the binding, from the trace. `AppData` is the platform's entrypoint an app's binding calls (ADR 0015). The trace has 9 of the roughly 22 calls.
- **Workspace:** a fresh one from the Worker Template.
- **The app:** a Hono Worker with one binding, `COUNTER`, to a `Counter` class. Each instance kept a count in its own SQLite table.
  - `/api/count/:name` added one to the instance of that name, and answered with the count and the code's version.
  - `/api/whoami/:name` answered with the instance's `ctx.id` and its name.
- **Check and Build:** the Check was clean, and the Build succeeded.

| Step | Platform Worker | `AppData` |
| --- | ---: | ---: |
| First request to the Preview, starting its instance | 980 ms | 42 ms |
| First request to the Deployment after publishing | 976 ms | 35 ms |
| Count requests once warm, the Preview and the Deployment (14) | 28–46 ms | 17–21 ms (2 in the trace) |
| First fetch from a newly opened page (2) | 41–65 ms | 18–44 ms |
| First request to the Preview after a new Build | 907 ms | 36 ms |
| First request to the Deployment after publishing again | 105 ms | 34 ms |

- **The first fetches from a newly opened page:** each was the first request on a new connection. Its call through the binding came about 0.6 s after the request reached the platform Worker, outside the request's own wall time. The trace doesn't say where that time went. In the browser the first of them took 660 ms.
- **The first requests' `AppData` events ended `canceled`,** though the requests got their answers.
- **Left out of the warm row:** the Deployment's first request after 48 s with no requests to it took 156 ms in the platform Worker.
- **In the browser:** counts took 53–92 ms once warm (14).
- **Instances by name:** "a" counted 1 to 5 in the Preview while "b" started at 1. Each instance had its own `ctx.id`, and `ctx.id.name` was its name.
- **The Preview and the Deployment apart:** after publishing, the Deployment's "a" started at 1 while the Preview's stood at 5.
- **New code:**
  - After a new Build answering "version 2", the Preview's "a" carried on from 5 to 6, as version 2.
  - The Deployment, not yet published again, stayed on version 1 and carried on from 3 to 4.
  - After publishing again, the Deployment answered as version 2 and carried on from 4 to 5.
- **Deleting the Workspace:** the Deployment's hostname then answered `404 There's no app here.`
- **Not tried live:** the Build errors for KV, D1, R2, queues and cron triggers, which the tests cover.

### App secrets (ticket 12)

- **Platform:** the deployed platform, measured on 2026-10-31 after ticket 12's deploy, from the Developer's signed-in browser (Chrome) in the UK.
- **Times:**
  - **Platform Worker:** its wall time for the request, from Cloudflare's trace, leaving out the network.
  - **App host:** its wall time for its `setSecret` or `removeSecret` call, with CPU where it had any. These figures can run on (`docs/development.md`).
- **Workspace:** a fresh one from the Worker Template.
- **The app:** a Hono Worker with three routes:
  - `/api/key` answered whether `API_KEY` was set, its length and its value;
  - `/api/log` logged a line with the value in it;
  - `/api/names` answered with the names in its `env`.

| Step | Platform Worker | App host |
| --- | ---: | ---: |
| Add a secret, through the Secrets dialog | 79 ms | 55 ms, 3 ms of CPU |
| Replace it, through the API | 41 ms | 18 ms |
| Remove it, through the API | 40 ms | 17 ms |
| First request after a change, on a new Worker (3) | 28–30 ms | |

- **A new Worker after a change:** that comes from the code, not the trace. The Worker's ID includes the secrets' version. The next request after one of them took 20 ms. The trace has no app host event for these requests.
- **The Secrets dialog:**
  - Adding `API_KEY` listed it with the time it was set, and cleared both fields.
  - The API then returned the name and that time, with no value.
  - Not tried live: the dialog's Replace and Remove, which the change and removal above went round.
- **The app's `env`:**
  - In the Preview, `/api/key` answered the Developer with the value itself, not hidden.
  - `/api/names` gave `API_KEY`, and `GREETING` from `vars`: none of the platform Worker's own secrets.
  - After publishing, the Deployment answered with the value too.
- **A change, with no new Build:**
  - After the value was replaced, the Deployment and the Preview both answered with the new one on their next request.
  - After it was removed, the Deployment answered that it wasn't set.
- **Deleting the Workspace:** the Deployment's hostname then answered `404 There's no app here.`

**The Turn:** "Without changing any files: use list_secrets to see the Workspace's secrets, then request GET /api/key on the Preview and read the Preview's logs. Tell me exactly what each showed you.", against a budget of $1. The browser didn't time it.

| Turn log | Steps | Retries | Input tokens (cache read / written) | Output | Cost |
| ---: | ---: | ---: | --- | ---: | ---: |
| 10.0 s | 3 | 0 | 17.4K (11.4K / 6.1K) | 0.6K | $0.04 |

- **What the Agent saw:**
  - `list_secrets` gave it `API_KEY`.
  - `request_preview` on `/api/key` gave it `{"set":true,"length":23,"key":"[secret API_KEY]"}`.
  - `preview_logs` gave it the line `calling the service with [secret API_KEY]`.
- **The value appeared nowhere in the Conversation.** The Agent learned the value's length only because the app's own code answered with it.
- **The Turn ended** with a clean Check and a cached Build.

### Found along the way

- **The trace can't show an instance's CPU.** `AppData` showed 0 ms on each of its 9 events, and the one app host `callFacet` event 2 ms. The app's own events go to its tail, which keeps only their logs.

## Stage 6: Tests in isolates

**Verdict: yes, in Chrome.** A Workspace's tests run on the deployed platform, on a runner built from vitest's own parts, each test file in a Dynamic Worker of its own (ADR 0017). The Agent wrote tests, ran them with its `test` tool, and its Turn ended with every test file run. Failures showed in the problems list, at their place in the file. Firefox and WebKit weren't checked.
- **Both Templates' tests pass.** The Worker Template's test calls a Hono route end to end. The Worker + React Template's also renders `App` to HTML with the real `react-dom/server`.
- **A run takes 0.5–1.5 s once warm,** in the platform Worker: 0.5–0.7 s for the Worker Template's one test file, 1.0–1.5 s for the React Template's two. The first run after a deploy took 2.5 s and 3.5 s.
- **The Workspace's Durable Object does almost none of the work:** 14–94 ms of CPU per run. The tests are bundled in a Dynamic Worker of their own. Bundled in the Durable Object, as first deployed, the React Template's tests put its isolate over the memory limit on the third run (below).
- **Known limits, by design (ADR 0017),** which don't qualify the verdict:
  - **No DOM:** components can be rendered to HTML and their logic tested, but not clicked.
  - **No module mocks, snapshots or coverage.** `vi.mock` and the snapshot matchers fail, saying they aren't supported.
  - **No app environment:** tests get none of the app's `vars`, secrets or Durable Object bindings unless they pass them in, and no network.
  - **One bundle:** a test file that won't bundle stops the others.

### The live check

- **Platform:** the deployed platform, measured on 2026-10-31 after #52's deploy, from the Developer's signed-in browser (Chrome) in the UK.
- **Times:**
  - **Browser:** the round trip of `POST /api/workspaces/:id/tests`, timed in the page.
  - **Platform Worker:** the time it logs for that request, from its call to the Durable Object being I/O.
  - **Durable Object:** the Workspace's wall time and CPU for its `runTests` call, from Cloudflare's trace. Bundling and each test file run in Dynamic Workers, whose time the trace doesn't show.
- **Workspaces:** one from each Template, made after #51's deploy and tested again after #52's.

| Run | Browser | Platform Worker | Durable Object |
| --- | ---: | ---: | ---: |
| Worker Template, the first after the deploy | 2,552 ms | 2,509 ms | 1,599 ms, 94 ms of CPU |
| Worker Template, again (2) | 565–709 ms | 516–667 ms | 508–658 ms, 14–20 ms of CPU |
| Worker + React Template, the first after the deploy | 3,576 ms | 3,547 ms | 3,012 ms, 91 ms of CPU |
| Worker + React Template, again (4) | 1,102–1,573 ms | 1,036–1,519 ms | 1,028–1,514 ms, 38–57 ms of CPU |

- **Every run passed:** the Worker Template's `the app > greets by name`, and the React Template's `App > renders its heading, and asks the Worker for a greeting` and `the Worker > greets by name`. The trace showed no memory errors.
- **A failing test:** a test file comparing `{ total: 2 }` with `{ total: 3 }` was saved to the Worker Template's Workspace, and Run tests pressed on its page.
  - The problems list's summary read "1 error", and its status "Tested at 12:16:00: 1 passed, 1 failed".
  - The Tests group listed `src/sum.test.ts:5:30` `sums > adds: AssertionError: expected { total: 2 } to deeply equal { total: 3 }`, with the diff below it.
  - Clicking it opened the file, at line 5.

**The Turn:** "Add a function slugify(text) in src/slug.ts that lowercases text, drops anything that isn't a letter, digit or space, and joins the words with hyphens. Write tests for it in src/slug.test.ts, including one for leading and trailing spaces, and run them with the test tool.", against a budget of $2, in a fresh Worker Template Workspace. The browser didn't time it.

| Turn log | Steps | Retries | Input tokens (cache read / written) | Output | Cost |
| ---: | ---: | ---: | --- | ---: | ---: |
| 16.0 s | 3 | 0 | 21.0K (13.4K / 7.6K) | 1.5K | $0.07 |

- **What the Agent did:** it wrote `src/slug.ts` and 8 tests, ran them with `test`, changed a test, and ran them again. Both runs were of that one file, and all 8 tests passed.
- **The end of the Turn:** a clean Check, a Build, then every test file: 9 passed, with the Template's own. `testFailures` was 0. The page's problems list showed the run when the Turn ended, without Run tests being pressed.

### Before the fix (#51's deploy)

The first live check, the same day after #51's deploy, ran each Template's tests three times. The Worker Template's passed, in 1,062 ms for the first run and 464–565 ms after, in the platform Worker, with 353–880 ms of the Durable Object's CPU. The React Template's found two problems, both fixed in #52:
- **`App.test.tsx` failed,** in every run's report: `Dynamic require of "util" is not supported`. worker-bundler resolves Packages with the `node` condition as well as `browser`, and `react-dom` lists the Node build of `react-dom/server` first. Packages now lose their `node` conditions before any bundling, Builds included, as with wrangler.
- **The third run returned 500:** "Durable Object's isolate exceeded its memory limit and was reset." The first two took 3,112 ms and 1,658 ms in the platform Worker, with 2,758 ms and 1,322 ms of the Durable Object's CPU, and the third 1,484 ms of CPU before the reset. Most of that was bundling, going by how far it fell once bundling moved out. esbuild bundled the tests with a source map there, and never gives memory back. Tests now bundle in a Dynamic Worker of their own, as Checks run (ADR 0010).

### Found along the way

- **The platform's own tests missed both problems.** The fake `react-dom` listed its browser build first, unlike React's, and local workerd doesn't enforce memory limits. The fake now lists `node` first.
- **Fake timers hang the platform's test suite.** Its Durable Objects run in the test file's isolate, so their timers stop too (`docs/development.md`).
- **A Durable Object method can't be called `test`** over RPC in the platform's tests: `test` is a Worker handler's name. The method is `runTests`.

## The Conversation panel

### Markdown replies (#44)

- **Platform:** the deployed platform, checked on 2026-10-30 after #44's deploy, from the Developer's signed-in browser (Chrome) in the UK. The window was 1280 × 800, so the Conversation panel was 384 px wide.
- **The page:** the Workspace page's script was #46's build: 949,156 bytes, and 315,634 bytes compressed in transfer. Built from `main` before #46, it was 943,299 bytes.
- **Workspace:** a fresh one from the Worker Template. Three Turns on the real model asked for replies and changed no files.
- **Watching:** the page recorded every change to the Conversation's list, any call to `alert`, `confirm` or `prompt`, and any request to `example.com`.
- **A reply with every element:**
  - Headings 1 to 6 became `<h3>` to `<h6>`, with levels 4 to 6 all `<h6>`.
  - Nested lists, a list numbered from 3, a ticked and an unticked task box (both disabled), a block quote, a rule, emphasis, strikethrough, inline code, a link and a bare URL all rendered. Both links had `target="_blank"` and `rel="noopener noreferrer"`.
  - A 12-column table scrolled inside its wrapper, showing 359 of its 518 px. A 364-character line of code scrolled inside its block, showing 357 of 2,824 px. The list stayed 383 px wide, with nothing to scroll sideways.
  - In the dark theme, code took the dark background (`#161615`) and border (`#393936`), and the text the dark text colour.
  - The accessibility tree read "The Agent:", then the headings, lists, task boxes, quote, rule, a table with column headers, and the code, in order.
- **A reply streaming 80 lines of code:**
  - It rendered 91 times in 6.7 s, about once every 50 ms.
  - The code block was a code block from the first render after its opening fence, 1.9 s in. Its fence never showed as text.
  - The block never got shorter. It stayed 1,553.6 px tall as its closing fence and the reply's last sentence arrived.
  - The list kept following the reply: on every render it was at most 1 px from the bottom.
- **A reply with raw HTML and unsafe links,** which the Agent repeated exactly from the Developer's message:
  - `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>` and `<!-- a comment -->` showed as text.
  - `![alt](https://example.com/a.png)` became a link labelled "alt".
  - `javascript:`, `JAVASCRIPT:`, `data:` and relative links, and `<javascript:alert(1)>`, showed as their text. `HTTPS://example.com` and `mailto:` became links.
  - Nothing called `alert`, the page had no `<img>`, and no request went to `example.com`.
- **Unchanged:** the Developer's messages stayed plain text, as typed.

## For people who don't write code (#56)

### The whole journey, live (#67)

**Verdict: yes.** On the deployed platform, a Developer described an app in their own words and got it working without choosing a Template or reading code. The Agent chose the Template, named the app, showed its steps, asked a question and for Secrets, and a change that left the app broken was put back. Every moment of #50's Variant E was there. Four fixes in #67 cover six of the differences, and the rest are #78, #79 and #80.

- **Platform:** the deployed platform at `main` (`ecef3ee`), checked on 2026-11-07 from the Developer's signed-in browser (Chrome) in the UK. The window was 1280 × 800 for the computer, and 390 × 844 for the phone. `DEPLOYMENTS_OPEN_TO_EVERYONE` was `false`.
- **Turns:** 10 Turns of Opus 5.5 in three Workspaces made for the check, against a budget of $5. They cost $1.97 at the tail script's prices. The Workspaces were deleted afterwards.
- **Times:** the browser's from the click in the page; the Turns' from their log lines.

**Starting an app and its first build:**

| App, as described | Template | Name | `POST /api/workspaces` | Turn log | Steps | Retries | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| "A sign-up sheet for my running club's Sunday runs" | Worker + React | Sunday Runs | 1.25 s to the app's page | 100.4 s | 8 | 0 | $0.38 |
| "A page where neighbours can borrow my lawnmower" | Worker + React | Borrow the Mower | 1.06 s | 119.0 s | 14 | 0 | $0.46 |
| "A webhook that my payment provider calls each time someone pays, adding the amount to a running total" | Worker | Payment Tally | 1.20 s | 9.6 s to start, then asked; not built | 2 | 0 | $0.06 |

- **Sunday Runs in the browser:** the click on "Make it" took 1.25 s to reach the app's page, and the Agent's steps showed at once. The reply arrived 101.7 s after the click, and the app in its frame at 105.5 s.
- **The webhook** started from the Worker Template, "a simple web address with no page, since only your payment provider needs to call it", then asked which payment provider. Given Stripe, it asked for the provider's signing secret, and the check stopped there.

**Each Turn:**

| Turn | Asked | Put back | Retries | Turn log | Cost |
| --- | --- | --- | ---: | ---: | ---: |
| Sunday Runs: the first build | – | no | 0 | 100.4 s | $0.38 |
| "Email me when someone signs up" | a Secret (the email service's key) | no | 0 | 13.1 s | $0.17 |
| After the key was added | a Secret (the address to send to) | no | 0 | 3.8 s | $0.01 |
| After the address was added: the emails | a Secret (a new key: the service refused the made-up one) | no | 0 | 83.9 s | $0.30 |
| "Set a limit on places with a waiting list. Ask me how many places before you build it." | a question, 4 answers | no | 0 | 2.7 s | $0.01 |
| "10 places" | – | no | 0 | 90.5 s | $0.41 |
| A deliberate type error, kept through every retry | – | **yes** | 3 | 29.3 s | $0.11 |
| Borrow the Mower: the first build | – | no | 0 | 119.0 s | $0.46 |
| Payment Tally: the first Turn | a question, 4 answers | no | 0 | 9.6 s | $0.06 |
| "Stripe" | a Secret (the signing secret) | no | 0 | 3.5 s | $0.06 |

- **How often the Agent picks each Template:** Worker + React for both apps with a page, and Worker for the webhook. 3 starts are too few to give rates.
- **How often a Turn asks:** 6 of 10 Turns ended by asking, 2 with a question and 4 for a Secret. Only one question was prompted ("Ask me how many places"). This journey went looking for questions and Secrets, so the rate is higher than ordinary use would give.
- **How often changes are put back:** 1 of 10 Turns, the one asked to keep a type error. No other Turn needed a retry.

**Each moment, against Variant E:**
- **Start:** "What would you like to make?", the box in its corner brackets, the three ideas and Your apps, each with its live state and when it last changed, as in Variant E. Picking an idea fills the box. The page adds "Signed in as" and "Shift+Enter starts a new line" (#78).
- **Working:** two bars above the app where Variant E has one (#78). The steps, ticked as they finished, without Variant E's second line of detail (#80), the current one in large type on the canvas with "1 of 4 steps done", "The Agent is working…" with the time, and "Making sure it works…" while the platform checked. **Fixed:** the header said "New app" until the Turn ended, where Variant E shows the name once the app is started; and the canvas had no label, where Variant E says "Making your app".
- **Ready:** the app in its frame, "Only you can see this until you publish.", Publish, and three suggestions above the message box. **Fixed:** the suggestions arrived after the Conversation had scrolled, which hid the end of the reply.
- **A Secret:** the field showed under the Agent's reason, said "Only your app can read it. It isn't kept in the chat, and the Agent never sees it", and saving it started the next Turn at once. The made-up value appeared nowhere on the page. **Fixed:** the field arrived below the fold, 113 px short of the bottom.
- **A question:** the four answers as buttons, "Or type an answer…" in the box, and picking one started the next Turn. **Fixed:** the buttons were cut off below the fold, as with the Secret's field.
- **Problem:** after "Found a problem, fixing it (try 1 of 3)" to 3 of 3, the frame turned red with "That didn't work. Your app hasn't changed.", the files were put back, and "Try a different way" was suggested. Variant E also offers "Leave it for now" (#80).
- **Published:** the first Publish said "Only people on this Jigworks's list will be able to use it, at …, once they've signed in." Then the header said "Live at …" with Copy the link, and the frame "Live. Only people on this Jigworks's list can use it." Variant E's frame says "Live at" the address instead; who can use it replaced that in #60, and the address is in the header. After an edit through See the code, it said "with changes not yet published", Publish changes, and "Changes not yet published. People with the link have the earlier version.", as in Variant E. **Fixed:** Publish changes said "in place of the one published 09:43:43", which is now "published 5 minutes ago".
- **The phone:** Chat and App tabs, and the App tab came forward when a change was done. The app starts 44% of the way down the screen, where Variant E's starts about 30% (#78).
- **Light and dark:** both modes kept the bench's colours, the brackets and the type, on the start page and the app's page, on a computer. The phone was checked in light mode only.
- **Your apps and renaming:** renaming from the header changed the name in the header, the title and Your apps, and the address stayed `sunday-runs-…`.
- **The Preview and the Deployment:** the Preview's frame loaded from `<label>-preview.jigworks.app` after its sign-in exchange. The Deployment opened at `<label>.jigworks.app` in 661 ms, through Access. After Delete, it said "There's no app here." From outside, `anything-preview.jigworks.app` reached the platform (404), and `anything.jigworks.app` redirected to Access.

### Short replies, and Secrets only for secrets (#79)

**Verdict: partly.** The Agent now asks for the address to send to with a question, not as a Secret, and no reply has headings or lists. The reply at the end of the first build is still five sentences, where the bar is three; the email Turn's is three. Two wordings were tried, with one run of #67's two Turns each.

- **Platform:** this branch under `wrangler dev` on 2026-11-08, with the real model (Opus 5.5) and the deployed platform's settings, driven from the T3 preview browser. The deployed platform runs `main`'s instructions until this merges, so the Turns couldn't run there first.
- **Turns:** 8 Turns in two Workspaces made for the check, against a budget of $2. They cost $1.23 at the tail script's prices. Both Workspaces were deleted afterwards.
- **Before** is #67's run on the deployed platform, above.

**The wordings:**
1. "two or three plain sentences at the end saying what changed and what the Developer could try in their app. No headings or lists."
2. "at the end one paragraph of no more than three plain sentences, saying what changed and what the Developer could try in their app. No headings, lists or second paragraph, and don't say how you made sure it works: the steps show that." This is the one in the pull request.

Both say "ask_for_secret is only for values that must stay secret, such as keys and passwords. Anything else the app needs, such as the address emails go to, ask for with ask, or choose something sensible", and the tool's description says the same.

**The reply at the end of each Turn:**

| Turn | Before (#67) | Wording 1 | Wording 2 |
| --- | --- | --- | --- |
| "A sign-up sheet for my running club's Sunday runs" | about 170 words, a bold heading and a six-item list | 103 words, 7 sentences in 2 paragraphs, no list | 67 words, 5 sentences in 1 paragraph, no list |
| The emails, once the key and address were given | not recorded | 102 words, 6 sentences in 2 paragraphs, no list | 59 words, 3 sentences in 1 paragraph, no list |

**How the address was asked for:**

| | Before (#67) | Wording 1 | Wording 2 |
| --- | --- | --- | --- |
| The email service's key | a Secret | a Secret (`RESEND_API_KEY`) | a Secret (`RESEND_API_KEY`) |
| The address to send to | a Secret (`NOTIFY_EMAIL`) | a question: "Which email address should the sign-up emails go to?", with "I'll type my address" and "Not sure which one I used" | the same question, with "I'll type my address" and "Let me check which one I used" |

The typed address went into the app's `vars` in `wrangler.jsonc`.

**Each Turn:**

| Turn | Wording | Asked | Steps | Turn log | Cost |
| --- | --- | --- | ---: | ---: | ---: |
| The first build | 1 | – | 9 | 76.1 s | $0.32 |
| "Email me when someone signs up" | 1 | a Secret | 2 | 8.9 s | $0.14 |
| After the key was added | 1 | a question | 2 | 5.8 s | $0.02 |
| "runs@example.com": the emails | 1 | – | 7 | 33.0 s | $0.13 |
| The first build | 2 | – | 8 | 83.2 s | $0.33 |
| "Email me when someone signs up" | 2 | a Secret | 2 | 9.4 s | $0.15 |
| After the key was added | 2 | a question | 1 | 5.7 s | $0.02 |
| "runs@example.com": the emails | 2 | – | 7 | 33.1 s | $0.13 |

- **The first build's reply** describes what the app does, a sentence per feature, and wording 2 cut it from seven sentences to five but not to three. One run of each wording is too few to tell the wording from chance.
- **Narration during a Turn** is unchanged: a sentence such as "Saving works. I'll remove that test entry so your list starts empty." still appears between the steps and the end.

### What each step decided, and leaving a failed change (#80)

**Verdict: yes.** In its first call to `steps`, the Agent gave "Choosing a starting point" and "Naming your app" their details, as Variant E's Working moment shows them. A change that was undone offers "Leave it for now" beside "Try a different way", and leaving it starts no Turn.

- **Platform:** this branch under `wrangler dev` on 2026-11-08, with the real model (Opus 5.5) and the deployed platform's settings, driven from the T3 preview browser. The deployed platform runs `main`'s instructions until this merges.
- **Turns:** one first build, "A sign-up sheet for my running club's Sunday runs", in a Workspace made for the check and deleted afterwards. 9 steps, 88.4 s, no retries, $0.38 of a $1 budget.

**The Agent's steps:**

| Step | Detail | In the first call |
| --- | --- | --- |
| ✓ Choosing a starting point | A web page that remembers things | yes, alongside `start_app` |
| ✓ Naming your app | Sunday Runs | yes |
| ✓ Building the sign-up sheet | Next four Sundays, name and optional pace | added once done |
| ✓ Making sure it works | – | – |

- **The reply before the work** still names the starting point: "I'll start your sign-up sheet from a web page that remembers things, since runners need to put their names down and see who else is coming."
- **The reply at the end** was one paragraph of four sentences (#79's bar is three).
- **"Making sure it works"** is the Agent's own step, ticked off before the platform's Check, Build and tests. Variant E's "All good" under it would need the platform to add the result; that's outside #80's decision.
- **Leaving a failed change,** checked with the scripted model: "Leave it for now" posted no Turn, the note and the suggestion went, and the app area's label went back to "Only you can see this until you publish." It isn't offered after a first build that was undone, as in Variant E.

### Found along the way

- **The page ran a Check and a Build when it opened an app with no files,** before the Agent had started it. They failed ("Could not determine entry point", and no `tsconfig.json`) and filled the hidden problems list. The page now runs them on opening only once the app is started.
- **The Agent's replies are longer than Variant E's,** with headings and lists, and it asked for an email address as a Secret (#79).
- **The Agent said the test email went through,** in both of #79's runs, though the email service's key was made up. The app logs a failed send rather than failing the sign-up, and the Agent had read the Preview's logs. In #67's run on the deployed platform it noticed the refusal and asked for a new key. Not looked into.

## Builds of a large app (#87)

**Verdict: over, so Builds moved to a Dynamic Worker.** On the deployed platform, every Build of a large app reset the Workspace's Durable Object: 37 in a row, and more until the Workspace was deleted. The reset came before esbuild had done much, from holding every Package file at once. Builds now run in the Builder, a Dynamic Worker reused by ID (ADR 0010), which is sent the files as a stream. The Durable Object then kept one isolate through ten rounds of saves, Checks and Builds, locally and deployed ("After, deployed", below), and through a Turn locally.

**But an app this size can't be built deployed at all (#99).** Locally, the Builder's esbuild reached 210–295 MB of linear memory, against an isolate's 128 MB. Deployed, every full Build failed as "The Build couldn't run: Worker exceeded memory limit.", with the Durable Object unharmed. The move protects the Workspace, its Conversation and Turns; it doesn't make large apps buildable. A moderately large app builds deployed, with esbuild at about half the limit.

### How it was measured

- **The app:** made by `scripts/large-workspace.mjs` through the API, with no Turns. It's the Worker + React Template with 120 components, 30 pages and 10 server routes, using recharts 3.10.1, date-fns 4.4.0, and @mui/material 9.5.0 with @emotion/react 11.14.0 and @emotion/styled 11.14.1. Every page and component imports from them, so the Build bundles them.
  - **Workspace files:** 180, 918 KB.
  - **Packages:** 122 after resolution, in 16,812 files of 46.6 MB. A bundle takes in 9,513 of those files, 36.6 MB; a Check reads 10.6 MB of type declarations and `package.json` files.
  - **Each round** is what a Developer's edit causes on the page: a save of one component, then a Check and a Build (`client/src/useChecks.ts`). The Workspace also builds a second after a save, so one of the two Builds is new and the other reused.
- **Deployed,** on 2026-11-09 with `main` at `909361f`, before the move: the script ran in the Developer's signed-in browser (Chrome), imported from this branch at a commit, with `wrangler tail` capturing. A reset shows as the outcome `exceededMemory` in the tail.
- **Locally,** under `wrangler dev` on a shared development machine, before and after the move. Local workerd enforces no memory limit, so it shows esbuild's memory but never a reset. The Durable Object's isolate is the name its log lines give (stage 4).

### Before: Builds in the Durable Object

| Deployed | Outcome | CPU ms | Wall ms |
| --- | --- | ---: | ---: |
| Installing the 122 Packages | ok | 2,117 | 4,687 |
| The Build after the first save | `exceededMemory` | 488 | 503 |
| The 36 tries that followed, every 30 s | `exceededMemory` | 412–745 | 439–765 |

- **The app was never finished:** after the reset, saves failed with 500 ("Durable Object's isolate exceeded its memory limit and was reset"), and each try at the Build reset the object again. 6 of the app's 163 files were written, so the client bundle was still the Template's. The ten rounds couldn't run; every Build there was is in the table.
- **Why:** a Build held all 46.6 MB of Package text, and its hash joined it all into one more string and then encoded that: about 140 MB before esbuild started.
- **Locally,** on the same code: esbuild's memory was 29 MB for the unfinished app and 231 MB once every page was in.

### After: Builds in the Builder

Locally, ten rounds in the finished app, with a fresh Builder. Each round's new Build was the one after the save; the page's own Build, after the Check, then found it and reused it, so the page waited for both.

| Round | Save | Check | Build, as the page waits | esbuild in the Builder | Receiving the files | Durable Object's isolate |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 78 ms | 2,543 ms | 23.8 s | 210 MB | 694 ms | `17bd0d67` |
| 2 | 35 ms | 2,492 ms | 20.4 s | 234 MB | 992 ms | `17bd0d67` |
| 3 | 34 ms | 2,153 ms | 22.7 s | 236 MB | 808 ms | `17bd0d67` |
| 4 | 30 ms | 2,137 ms | 22.5 s | 239 MB | 736 ms | `17bd0d67` |
| 5 | 32 ms | 2,163 ms | 22.6 s | 239 MB | 845 ms | `17bd0d67` |
| 6 | 28 ms | 2,214 ms | 22.7 s | 239 MB | 777 ms | `17bd0d67` |
| 7 | 30 ms | 2,166 ms | 22.5 s | 295 MB | 816 ms | `17bd0d67` |
| 8 | 29 ms | 2,141 ms | 22.4 s | 295 MB | 789 ms | `17bd0d67` |
| 9 | 32 ms | 2,158 ms | 22.7 s | 295 MB | 816 ms | `17bd0d67` |
| 10 | 32 ms | 2,181 ms | 22.8 s | 295 MB | 815 ms | `17bd0d67` |

- **Every Build passed,** each with a new hash, and every Check found no errors.
- **esbuild's memory** stays at its peak, since linear memory never shrinks. An earlier run in a fresh Builder went the same way, from 211 MB to 301 MB.
- **The cost of sending the files:** a stream of 9,513 files and 36.6 MB for each new Build, which one call couldn't carry (32 MiB). The Builder took 0.7–1.0 s to receive it, about 4% of the Build, on a machine with a load average over 30 from other work. A reused Build sends nothing. The Builder logs it as `receivingMs`. Deployed, it reads 0: the clock didn't move while the stream arrived, so it measures nothing there.
- **Hash and output unchanged:** the hash is computed as before from every file, type declarations included. The Build tests check it against the old one, and check a Builder's Build equals one made in this isolate (`test/builder.test.ts`).

**A Turn,** with the scripted model, locally, in a second copy of the app whose first message picked the `break-then-fix` script (`scripts/large-workspace.mjs`'s `turn`):

| Turn | Steps | End-of-Turn Check | End-of-Turn Build | esbuild in the Builder | Receiving the files | Durable Object's isolate |
| --- | ---: | --- | --- | ---: | ---: | --- |
| 24.4 s (Turn log) | 2 | no errors | new, ok | 295 MB | 776 ms | `17bd0d67`, as before it |

- **The tests that end the Turn** bundled through the same stream: 7 passed and 1 failed, the Template's own `App.test.tsx`, which looks for the heading the large app replaced.

### After, deployed

On 2026-11-09 after #98's deploy (`939735a`), the same ten rounds in two Workspaces made by the script, from the Developer's signed-in browser, with the tail running. CPU and wall time are the Durable Object's, from the trace of each new Build's call.

**A moderately large app,** the script's `moderate` shape: the Worker + React Template with 60 components, 15 pages and 5 routes, and date-fns as its one added Package. 100 Workspace files, 756 KB, 8 Packages.

| Round | Save | Check | Build, as the page waits | Durable Object CPU / wall | esbuild in the Builder | Durable Object's isolate |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 77 ms | 2,375 ms | 3,642 ms | 215 / 5,647 ms | 49 MB | `12a792df` |
| 2 | 79 ms | 1,165 ms | 2,882 ms | 396 / 3,021 ms | 51 MB | `12a792df` |
| 3 | 81 ms | 1,345 ms | 4,114 ms | 217 / 2,031 ms | 51 MB | `12a792df` |
| 4 | 116 ms | 1,079 ms | 2,814 ms | 378 / 1,772 ms | 53 MB | `12a792df` |
| 5 | 74 ms | 1,126 ms | 2,683 ms | 220 / 1,671 ms | 53 MB | `12a792df` |
| 6 | 91 ms | 1,076 ms | 4,885 ms | 225 / 2,901 ms | 53 MB | `12a792df` |
| 7 | 74 ms | 1,344 ms | 2,749 ms | 223 / 1,753 ms | 53 MB | `12a792df` |
| 8 | 85 ms | 1,199 ms | 2,667 ms | 207 / 1,578 ms | 55 MB | `12a792df` |
| 9 | 79 ms | 1,093 ms | 2,613 ms | 222 / 1,295 ms | 59 MB | `12a792df` |
| 10 | 90 ms | 1,190 ms | 2,855 ms | 378 / 1,809 ms | 59 MB | `12a792df` |

- **Every Build passed,** each with a new hash, and every Check found no errors. esbuild stayed under half the Builder's 128 MB.

**The large app,** as before: 180 Workspace files, 122 Packages, 46.6 MB of Package text.

| Rounds | Save | Check | Build, as the page waits | Durable Object CPU / wall per Build | Outcome | Durable Object's isolate |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 1–10 | 2.2–7.6 s | 11.1–15.0 s, no errors | 11.4–15.2 s | 490–1,721 / 6,001–16,602 ms | "The Build couldn't run: Worker exceeded memory limit." | `524e28e9` throughout |

- **No reset:** the Durable Object's 75 Build and Check log lines all came from one isolate, and no call ended `exceededMemory`. While the app was being written, its Builds passed, with esbuild at 25–33 MB; once `App.tsx` imported every page, every Build failed in the Builder.
- **The Durable Object's share of a failing Build** was 0.5–1.7 s of CPU: reading and hashing every file, then streaming 36.6 MB. A failed Build isn't kept, so the same files are built, and fail, again each time: the page's Build after the save's, and each Build a save scheduled.
- **The saves waited** 2–8 s for the Workspace's lock, held by failing Builds.

### Found along the way

- **A Build that resets the Durable Object in an alarm runs again every 30 s, without end.** The Build after a save is an Agents SDK schedule; after the first reset, it was tried again every 30 s from 07:32 until the Workspace was deleted at 09:35. With Builds in the Builder, a Build no longer resets the object, but anything else that does in an alarm would loop the same way. Not looked into.
- **esbuild's Go heap can't be capped from outside.** esbuild's browser build makes its Go runtime with an empty environment, so `GOGC` can't be set without patching esbuild at pack time. #99 does that, with `GOGC=25`.
- **The test bundle had the same limits:** `runTests` also held every Package file, and its call to the Test bundler couldn't carry more than 32 MiB. It now gets the same stream.
- **Saves made at the same time leave extra Builds scheduled.** Each save schedules a Build a second later, and cancels only the one whose ID it stored, so saves that overlap, as the script's six at a time do, each leave one. In the large app, 44 Builds that saves scheduled failed in all, and the leftovers ran about one every 6 s for 80 s after the last round. In the moderate app they were reused Builds and cost nothing. The page saves one file at a time. Not looked into.
- **Local workerd does enforce the RPC limit:** one call with 40 MB of arguments failed with "Serialized RPC arguments or return values are limited to 32MiB". A stream of more went through.

## How large an app can build (#99)

**Verdict, locally: what decides the limit is the Packages an app bundles, not how much code it has, and starting esbuild with `GOGC=25` lowers its peak by a fifth to a quarter. Where the limit sits deployed, before and after, is still to measure (below).** A Build that goes over the Builder's memory limit twice, the second time in a new isolate, now fails with "Your app has grown too big to build here. Try removing a ready-made part.", which the page shows as it is. The Agent is told it once, with instructions to tell the Developer in plain words and suggest a ready-made part the app could do without, rather than remove one itself. The Turn then ends and is undone, as any Turn that leaves the app broken is (`test/conversation.test.ts`). The second try is because a Builder is shared: another Workspace's Build there, or earlier Builds' memory, can put a Build that fits over the limit (ADR 0010).

### How it was measured

- **Platform:** `wrangler dev` on a shared development machine, on 2026-11-09. Local workerd enforces no memory limit, so these figures are esbuild's linear memory in the Builder (#87), not outcomes.
- **The apps:** `scripts/large-workspace.mjs`, with three new shapes between the moderate and the large:

| Shape | Components, pages, routes | Packages added | Packages after resolution | Files sent to the Builder |
| --- | --- | --- | ---: | ---: |
| `moderate` | 60, 15, 5 | date-fns | 8 | 5,904 |
| `small` | 6, 2, 1 | the UI kit (@mui/material, @emotion/react, @emotion/styled) and date-fns | 85 | 11,109 |
| `ui` | 60, 15, 5 | the same | 85 | 11,180 |
| `half` | 60, 15, 5 | the UI kit, date-fns and recharts | 122 | 16,913 |
| `large` | 120, 30, 10 | the same | 122 | 16,993 |

- **One Build at a time:** for the tables below, a change made only for measuring gave each Build a new Builder, so each figure is that Build's own peak, with nothing kept from earlier Builds. The same change built the front end alone or the Worker alone, and passed esbuild's Go runtime an environment. The rounds in a reused Builder ran on the change as it ships.

### esbuild's peak, by app

Each Build in a new Builder, 2–7 Builds per figure:

| Shape | Before | Front end alone | Worker alone | With `GOGC=25` |
| --- | ---: | ---: | ---: | ---: |
| `moderate` | 46–48 MB | 47 MB | 13 MB | 36 MB |
| `small` | 110–111 MB | | | 82 MB |
| `ui` | 149–151 MB | 151 MB | 13 MB | 111 MB |
| `half` | 168–195 MB | | | 154 MB |
| `large` | 176–209 MB | 180–208 MB | 14 MB | 158 MB |

- **The Packages decide it:** six components with the UI kit took esbuild to 110 MB, against 47 MB for sixty without it, and halving the large app saved little. Importing from `@mui/material` has esbuild read the whole kit, whatever the app uses of it.
- **Build times changed little with `GOGC=25`,** as the API caller saw them, on a machine shared with other work: `moderate` 4.5–4.9 s either way, `small` 13.3–13.5 s before and 12.1 s after, `ui` 18.2–19.6 s and 17.8–18.3 s, `half` 20.9–22.2 s and 23.3–23.8 s, `large` 23.0 s and 24.6 s.

### What lowers it

- **Building the front end and the Worker in separate calls doesn't help.** worker-bundler's `createApp` already bundles them in two esbuild calls, one after the other. Each alone, in a Builder of its own, the front end peaked where the whole Build did, and the Worker at 13–14 MB. Not kept.
- **There were no source maps to leave out.** worker-bundler makes them only when asked (`sourcemap`, off by default), and the Builder never asks. Leaving out minifying instead raised `moderate` from 47 MB to 60 MB.
- **`GOGC=25` helps:** Go collects its heap once it has grown by a quarter since the last collection, not once it has doubled, and esbuild's linear memory only grows, so its peak falls with it. Kept, for the Builder and the Test bundler, by patching esbuild's Go runtime when they're packed (`scripts/pack-tester.mjs`). In `small`, `GOGC=50` gave 103 MB and `GOGC=10` 82 MB, as `GOGC=25` did: that's about what's live. `GOMEMLIMIT=64MiB` gave 84 MB; set below what's live, at 32 or 48 MiB, it collected without end, and the Build hit the 60-second timeout.

### In a reused Builder

Deployed, a Builder is reused by its ID, and its memory builds up across Builds (#87). Ten rounds of the script's save, Check and Build in `small`, each in one Builder:

| | Round 1 | Round 2 | Round 3 | Rounds 4–10 | Build, as the caller waits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 99 MB | 108 MB | 121 MB | 121 MB | 13.0–13.8 s |
| With `GOGC=25` | 82 MB | 91 MB | 91 MB | 91–93 MB | 11.9–14.0 s |

### Where the limit sits

- **Deployed, before:** `moderate` builds, with esbuild at 49–59 MB in a reused Builder, and `large` doesn't (#87). A Builder's 128 MB also holds what esbuild doesn't: the files it's sent, held as text, and the JavaScript heap, which workerd doesn't report.
- **So, locally, before:** apps without the UI kit, like `moderate`, fit; `small`, with esbuild at 99–121 MB, very likely doesn't, and nor does any larger shape.
- **With `GOGC=25`:** `small` peaks at 82–93 MB, which may fit; `ui` at 111 MB very likely doesn't. Whether a small app with the UI kit now builds deployed is the question the deployed check answers.
- **To measure deployed,** from the Developer's signed-in browser with the tail running, as for #87: `small`, then `ui`, before the deploy and after it, with the outcome and esbuild's memory of each Build. Access asked for a sign-in on 2026-11-09, so neither has run yet.

## Add-ons (#88)

### Add-ons together, live (#94)

**Verdict: yes, with a caveat.** On the deployed platform, the Agent added add-ons when a request needed their abilities, and only then. Each was its own step, with a detail, and the Agent asked for each Secret in turn with the add-on's reason. With made-up Secrets, the app kept working, and its logs said plainly why the email wasn't sent and Claude wasn't asked. The three ideas' first builds took 75 to 103 s, against #67's 100 to 119 s, and the one that added two add-ons took 146 s. **The caveat:** those logs are under "See the code", so a Developer who doesn't write code isn't told, and the Agent's reply said an email "should arrive" (#104).

- **Platform:** the deployed platform at `main` (`99e701f`), checked on 2026-11-09 from the Developer's signed-in browser (Chrome, T3's preview tools) in the UK.
- **Turns:** 8 Turns of Opus 5.5 in four Workspaces made for the check, against a budget of $4. They cost $2.91 at the tail script's prices. The Workspaces were deleted afterwards.
- **Secrets** all had made-up values, so Resend and Anthropic were expected to refuse.
- **The three ideas ran at once,** each from the start page in its own tab. The fourth app followed on its own.
- **Tested as an app** before the check: `test/addons.test.ts`'s "add-ons together" starts a Workspace from the default Template, adds the organiser's area, email and AI in one step, as Opus calls tools, and makes their joining edits. It has a clean Check, Builds, passes every test file, the Template's and each add-on's, and works in the Preview with and without the Secrets.

**First builds, and the add-ons the Agent chose:**

| App, as described | Name | Template | Add-ons added | `POST /api/workspaces` | Turn log | Steps | Retries | Cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| "A sign-up sheet for my running club's Sunday runs" | Sunday Runs | Worker + React | none | 1.35 s to the app's page | 74.6 s | 10 | 0 | $0.32 |
| "A page where neighbours can borrow my lawnmower" | Mower Share | Worker + React | none | 1.10 s | 102.8 s | 14 | 0 | $0.45 |
| "A rota for who's cleaning the office kitchen" | Kitchen Rota | Worker + React | none | 2.16 s | 103.3 s | 11 | 0 | $0.40 |
| "A sign-up sheet for my book club's monthly meetings. Only I should be able to see everyone's details and remove people, and I'd like an email each time someone signs up." | Book Club Sign-ups | Worker + React | `organiser`, `email` | 2.10 s | 145.7 s, then asked | 12 | 0 | $0.56 |

- **Storage:** all four apps kept their records in the default Template's store, with `collection` from `./store`, and none wrote a Durable Object of its own.
- **Against #67:** the same two ideas took 100.4 s and 119.0 s there, and 74.6 s and 102.8 s here. Two runs each are too few to give the cause. #79's and #80's local runs of Sunday Runs, with the Template before storage, already took 76 to 88 s.
- **#99 didn't happen:** every Build passed.

**The Book Club Turns:**

| Turn | Asked | Add-ons added | Turn log | Steps | Cost |
| --- | --- | --- | ---: | ---: | ---: |
| The first build | a Secret (`ORGANISER_PASSCODE`) | `organiser`, `email` | 145.7 s | 12 | $0.56 |
| After the passcode was saved | a Secret (`RESEND_API_KEY`) | – | 7.7 s | 1 | $0.22 |
| After the key was saved | – | – | 11.1 s | 3 | $0.04 |
| "In my organiser's area, sort each sign-up's note into a question for me, a suggestion, or just a comment, so I can see what needs an answer." | a Secret (`ANTHROPIC_API_KEY`) | `ai` | 136.1 s | 22 | $0.58 |
| After the key was saved | – | – | 8.9 s | 2 | $0.34 |

- **The steps** for the add-ons: "Adding your private organiser area" (detail "Opens with a passcode"), "Adding sign-up emails" ("Sent through Resend to an address you choose") and, in the later Turn, "Adding an AI model to read notes" ("Claude, with your own key").
- **The Secrets' reasons** on the page were the add-ons' own, word for word.
- **The address emails go to** wasn't asked for. The Agent made it a setting in the organiser's area, kept in the store, where the email add-on's notes say to ask for it and keep it in `vars`. No ticket: the organiser can change it without a Turn, and it wasn't asked for as a Secret, which is what the notes guard against (#79).

**Trying the app in its Preview,** in the browser:
- **The organiser's area:** its routes answered 401 before signing in, a wrong passcode got "That passcode isn't right." with a 401, and the made-up passcode signed in. A meeting and the address were then saved.
- **A sign-up** was kept and counted, and answered `{"ok":true}`. The Preview's logs said "Resend refused the email: API key is invalid".
- **A sign-up with a note,** once the AI key was saved, was kept too. The logs said "Claude wasn't asked: Anthropic answered 401 (authentication_error): invalid x-api-key", and the organiser's page showed the note as "Not sorted yet", with a "Sort it" button to sort it by hand.
- **Where the Developer sees it:** the Logs, under "See the code". The Workspace page's own view shows neither refusal, and the Agent's last replies said "an email should arrive" and that each note is sorted as it comes in. Like #67's "the test email went through", the Agent can't know that a key is made up (#104).

### Found along the way

- **Two file tools changing one file in the same step lost a change, in 2 of 8 Turns (#103).** In Mower Share, two `edit`s of `src/server/store.ts` in one step reported 121 lines and then 120, and the Check found the first's method missing. In Book Club, the Agent said "The parallel edits clashed again, so I'll add that test back". Both times it noticed and put it right, with no retries.
- **Kitchen Rota suggested "Email whoever's on the rota each Monday",** a scheduled reminder, which apps can't have yet (ADR 0015, #88's Out of Scope). The Agent's instructions don't say so. #88 makes scheduled reminders a platform ticket of their own, which doesn't exist yet.
- **The Book Club check went past #94's "organiser's area and emails",** adding AI in a later Turn, to see an add-on added after others. Those two Turns cost $0.92.
- **Two Turns after a Secret cost more than their size:** $0.22 for 1 step and $0.34 for 2, where the other such Turn cost $0.04. Not looked into.

## Stage 7: R2 as a shared Package cache (#19)

**Verdict: yes, the cache stays (ADR 0020).** On the deployed platform, a tarball from the Package cache arrived in 86–138 ms, against 280–465 ms from npm, in six pairs of the same Package added to two Workspaces. That saved 0.14–0.34 s of each Package added, and the browser waited 93–347 ms less. The Durable Object's CPU didn't change: unpacking and checking a tarball cost the same from either. Resolving against the npm registry is still the larger part of a Template's install, and still happens every time, for the one-day minimum age. Storage per Workspace doesn't change, by design. Locally, the cache saved less: npm answered faster from the development machine than from the Durable Object.

- **The minimum age and integrity:** the cache never chooses a version, and every tarball it gives is checked against the registry's integrity value before use (`test/packages-tarball.test.ts`, `test/packages.test.ts`). A cached copy that fails the check is downloaded again from npm and replaced.

### Locally

- **Platform:** `wrangler dev` on a shared development machine on 2026-11-09, with the real npm registry and wrangler's local R2, a folder on disk. Each time is curl's, against the local platform.
- **Each round:** a Workspace from each Template (`POST /api/workspaces`), then adding date-fns (4.4.0), then a Check.
- **Without the cache:** this branch with the cache switched off in the code, so every tarball came from npm: three rounds, the third cut short after the Worker + React Workspace was made.
- **Cold:** the cache on and its bucket empty. Each tarball came from npm and was copied into the bucket; the Worker Template's Workspace came first, so the Worker + React Template's found Hono already there.
- **Warm:** three more rounds, every tarball cached.

| | Packages from | Create the Workspace | Add date-fns | Check |
| --- | --- | ---: | ---: | ---: |
| Worker Template | npm, no cache (3) | 209–413 ms | 549–2,374 ms | 138–356 ms |
| Worker Template | npm, copied into the cache | 319 ms | 494 ms | 276 ms |
| Worker Template | the cache (3) | 121–172 ms | 409–489 ms | 128–143 ms |
| Worker + React Template | npm, no cache (3) | 997–1,952 ms | 1,135–1,514 ms (2) | 353–456 ms (2) |
| Worker + React Template | npm, copied into the cache, but Hono | 877 ms | 1,001 ms | 410 ms |
| Worker + React Template | the cache (3) | 752–908 ms | 911–1,019 ms | 317–333 ms |

**The `install` log lines** split each install into resolving and fetching, by the Durable Object's clock:

| Install | Tarballs fetched | Tarball bytes | Resolving: no cache / cold / warm | Fetching: no cache / cold / warm |
| --- | ---: | ---: | --- | --- |
| Worker Template | 1 | 245 KB | 70–130 / 98 / 42–65 ms | 54–73 / 76 / 9–30 ms |
| Worker + React Template | 7 | 1.9 MB | 690–1,530 / 513 / 503–703 ms | 119–272 / 188 / 56–89 ms |
| Adding date-fns to the Worker Template | 1 | 1.6 MB | 57–71 / 44 / 43–55 ms | 179–1,956 / 154 / 79–88 ms |
| Adding date-fns to the Worker + React Template | 1 | 1.6 MB | 675–1,013 / 593 / 545–642 ms | 170–195 / 86 / 67–83 ms |

- **Resolving is most of an install:** 0.5–1.5 s of the Worker + React Template's, with or without the cache. It reads each Package's registry document one after another as the walk finds them, and the full document of any changed in the last day, for its publish times.
- **Fetching** fell by a half to two-thirds with a warm cache, and stopped varying with npm: the one 2-second fetch was from npm. What's left is unpacking each tarball and checking its hash, which the cache can't save.
- **A Check doesn't touch the cache:** it installs only when `package.json` changed, so its times differ only with the machine.
- **Storage per Workspace,** the Durable Object's database size after each install: 2.5 MB for the Worker Template, 12.2 MB for the Worker + React Template, and 12.1 MB more with date-fns. The same with or without the cache: each Workspace keeps its own copy.

### Deployed

- **Platform:** the deployed platform at `main` (`00e3e43`), with #114's cache, checked on 2026-11-09 from the Developer's signed-in browser (Chrome, T3's preview tools) in the UK, through the API, with `wrangler tail` capturing. Fetching and resolving are the `install` lines' times; CPU is from each call's trace; the browser time is the API call's round trip.
- **Workspaces:** eight made for the check, deleted afterwards.
- **The cold round wasn't cold.** Other threads were checking at the same time: one made a Worker Template Workspace at 18:13, before the tail started, which cached Hono, and one made a Worker + React Template Workspace at 18:18:20, seconds before this check's, which cached the rest of that Template. Its install is the one cold Template install below. Every other install of a Template here took all its tarballs from the cache. So the comparison that counts is the paired adds.
- **Without the cache:** a cold install is that path, plus copying each tarball into R2. A check of the platform before the deploy didn't happen: Access asked for a sign-in then.

**Adding a Package,** in pairs: each added first to one Worker Template Workspace, from npm, then to another, from the cache. The Packages were ones no Workspace had added before.

| Package | Tarball | Fetching: npm / cache | Browser: npm / cache | Durable Object CPU: npm / cache |
| --- | ---: | ---: | ---: | ---: |
| zod 4.6.7 | 1,142 KB | 465 / 126 ms | 1,014 / 667 ms | 321 / 317 ms |
| lodash-es 4.18.1 | 150 KB | 403 / 97 ms | 683 / 355 ms | 119 / 94 ms |
| marked 18.1.3 | 143 KB | 324 / 86 ms | 552 / 338 ms | 73 / 104 ms |
| yaml 2.9.1 | 112 KB | 367 / 115 ms | 635 / 535 ms | 77 / 164 ms |
| immer 11.2.9 | 262 KB | 280 / 138 ms | 535 / 442 ms | 70 / 80 ms |
| valibot 1.5.0 | 189 KB | 322 / 121 ms | 648 / 542 ms | 131 / 109 ms |

**The rounds:** a Workspace from each Template, then adding date-fns (4.4.0), then a Check; four rounds, the first meant to be cold.

| | Packages from | Create (browser) | Its install: resolving / fetching | Add date-fns (browser) | Its install: fetching | Check (browser) |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| Worker Template | npm (date-fns, once) | – | – | 1,040 ms | 338 ms | 745 ms |
| Worker Template | the cache (4, 3 for date-fns) | 1,227–1,677 ms | 46–76 / 111–131 ms | 1,038–1,428 ms | 121–337 ms | 756–986 ms |
| Worker + React Template | npm, but Hono (the other thread's) | not timed | 429 / 603 ms | – | – | – |
| Worker + React Template | the cache (4) | 2,495–3,245 ms | 349–519 / 161–459 ms | 1,816–2,198 ms | 148–423 ms | 1,050–1,456 ms |

- **A Template's install:** with every tarball cached, the Worker + React Template's took 349–519 ms resolving and 161–459 ms fetching, with 0.95–1.46 s of the Durable Object's CPU; the cold one, 429 ms and 603 ms, with 1.15 s. One cold install is too few to say more than that the cache didn't make it slower.
- **Checks** took 705–942 ms (Worker Template) and 1,005–1,346 ms (Worker + React) in the platform Worker. They don't touch the cache.
- **Storage per Workspace,** the database size after each install, matched the local figures to within 0.1%: 2.5 MB for the Worker Template, 12.2 MB for the Worker + React Template, and 12.1 MB more with date-fns.
- **The bucket** held 14 tarballs, 5.5 MB, after the check. No `package-cache-failed` line appeared.

### Found along the way

- **Resolving one Package at a time** is most of an install, cache or not. Fetching the documents a round needs at the same time would likely save more than the cache does. Not looked into.

## Schedules (#107)

**Verdict: an app's Durable Objects can't have alarms of their own, but the app host can keep their alarms for them.** workerd refuses `setAlarm` in a facet, and `alarm()` never runs, in the Preview or the Deployment, locally and deployed. Deployed, the refusal is quieter than it is locally: the first `setAlarm` fails the call, but its writes and the time are kept, and later ones succeed without ringing ("Deployed", below). The rest was measured locally. In a probe, the module the platform wraps the app in put its own `setAlarm` on each instance's `ctx.storage`. That `setAlarm` handed the time to the app host, whose one alarm then called the instance's `alarm()`. Each slot rang with its own code and data, and the alarm survived a new Build. The app host can also call an app's `scheduled` handler in the same way.

### How it was measured

- **Locally:** the platform's vitest pool, workerd 1.20261006.1 (wrangler 4.149.0), on 2026-11-09, on a shared development machine.
- **The app:** one binding, `PINGER`, to a `Pinger` class. Its `alarm()` handler writes a row to the instance's own SQLite table. Routes set an alarm, read the rows and the pending alarm, and write a row and then set an alarm in the same call. It's `test/alarm-probe.test.ts` on the branch `107-schedules-probe` (`133345d`), which isn't for `main`.
- **The app host keeping alarms:** on the same branch, the wrapper module (`src/apphost/app-data.ts`) replaces `setAlarm`, `getAlarm` and `deleteAlarm` on the instance's own `ctx.storage` object with calls through `AppData`. The app host learns which instance is calling from `ctx.props`, which it passes to `getDurableObjectClass`. It keeps each instance's time and sets its own alarm. When that alarm rings, it calls the instance's `alarm()` by RPC under a platform name, since `alarm` itself "is a reserved method and cannot be called over RPC".
- **The app host running a schedule:** the wrapper exports a named entrypoint, `JigworksScheduled`, whose `run(cron, scheduledTime)` calls the app's `scheduled(controller, env, ctx)`, with the bindings' stand-ins in `env`. The app host's `alarm()` calls it.
- **Source and docs,** read on 2026-11-09: workerd at `v1.20261006.1` and at `main` (`95fcc06`), and Cloudflare's docs at `606d41ed` of `cloudflare/cloudflare-docs`.

### An instance's own alarms

| Case | What the app got | Rows written by `alarm()` | `getAlarm()` after |
| --- | --- | ---: | --- |
| `setAlarm` in the Preview, 300 ms ahead, then 2 s | `500 The app threw an error: Error: Facets currently cannot set alarms.` | 0 | `null` |
| `setAlarm` 1.5 s ahead, then a new Build aborting the instance, then 3 s | the same `500` (no alarm for the abort to cancel) | 0 | `null` |
| `setAlarm` in the Deployment, 300 ms ahead, then 2 s | the same `500` | 0 | `null` |
| A row written, then `setAlarm`, in one call | the same `500` | – | `null`, and the row is gone |

- **The refusal comes at commit,** not from `setAlarm` itself. `setAlarm` stores the time; when the call's writes commit, workerd tries to schedule the alarm and fails. That breaks the instance's output gate, so the error replaces the call's answer. The app's own `try`/`catch` never sees it, and locally every write in the call is lost with it. The next call starts the instance afresh. Deployed differs (below).
- **Why:** workerd gives a facet's storage `FacetAlarmHooks`, whose `scheduleRun` fails with that message. Its comment says the alarm scheduler "only knows how to deliver alarms to the root actor of a namespace. TODO(someday): Support alarms in facets, somehow." (`src/workerd/server/server.c++` at the tag; `src/workerd/server/factory/worker-factory-actor.c++` on `main`). workerd's own test, "Durable Object facets cannot set alarms", expects the error. The comment says the message matches the one from Cloudflare's own storage factory, and the deployed platform gives it.
- **Cloudflare's docs** say nothing about alarms on the facets page. The Agents SDK's sub-agents page says "facets do not have independent alarm slots". There, the parent owns the alarm, records which child each callback belongs to, and routes the work back. That's what the app host does in the probes below.
- **`test/app-data.test.ts` pins the local behaviour:** if a workerd upgrade gives facets alarms, it fails.

### The app host keeping an instance's alarms

| Case | Rang | Code that ran `alarm()` | Rows afterwards |
| --- | --- | --- | --- |
| `this.ctx.storage.setAlarm` in the Preview, 300 ms ahead | yes, `{ retryCount: 0, isRetry: false }` | version 1 | 1 in the Preview's instance |
| The same in the Deployment, 600 ms ahead | yes | version 1 | 1 in the Deployment's instance, none from the Preview |
| Set 1.5 s ahead by version 1, then a new Build | yes | version 2 | 2 in the Preview's instance, the first kept |

- **The app's code is Cloudflare's own:** `this.ctx.storage.setAlarm(...)` and an `alarm()` handler. `getAlarm()` read the time back, and read `null` once the alarm had rung.
- **The wrapper can't swap `ctx` for a stand-in.** The `DurableObject` base class refuses one ("constructor parameter 1 is not of type 'DurableObjectState'"). Defining the three methods on the instance's real `ctx.storage` object worked. The platform would rely on that, as it relies on other facet behaviour, so a test should pin it.
- **The Preview's alarm rang late,** with the Deployment's: the probe set the app host's one alarm for whichever time came last. A real version sets it for the earliest due time.
- **Unlike Cloudflare,** the probe's alarm isn't written with the instance's other writes in one commit. It's a call to the app host, and is kept even if the instance's call later fails, or `deleteAll()` clears the instance. The recommendation's first two steps close that gap.

### The app host running an app's schedule

| Slot | Code it ran | What `scheduled` did | Rows afterwards |
| --- | --- | --- | --- |
| Preview, after a second Build | version 2 | wrote the cron string to instance "a" through `env.PINGER` | 1 in the Preview's "a", as version 2 |
| Deployment, published from the first Build | version 1 | the same | 1 in the Deployment's "a", as version 1 |

- **Both ran within a second** of the app host's alarm, each in its own slot's Dynamic Worker and reaching its own slot's instances.
- **`scheduled` can't be called the usual way.** A Fetcher's `scheduled()` method exists only under the experimental flag `service_binding_extra_handlers` (`src/workerd/api/http.h`), which Cloudflare refuses. Calling a named entrypoint over RPC already works deployed: the Tester is called that way (`src/tester/index.ts`).
- **The app host has one alarm,** which retired Secrets already use (`retireSecret` and `alarm()` in `src/apphost/index.ts`).

### Deployed

On 2026-11-09, with `main` at `00e3e43`, from the Developer's signed-in browser (Chrome) with the tail running. A Workspace made for the check through the API got the app from `test/app-data.test.ts`, with an `alarm()` handler that writes a row. `/remind` writes a row, then sets an alarm, catching any error; `/state` reads the rows and `getAlarm()`. The Preview was reached through sign-in links in a frame and read through its logs. The Deployment was reached at its URL. The Workspace was deleted afterwards.

| Slot | Step | What the app got | Rows | `getAlarm()` |
| --- | --- | --- | ---: | --- |
| Preview | `/state` | – | 0 | `null` |
| Preview | `/remind`, 300 ms ahead | `Error: Facets currently cannot set alarms.`, in the logs as an exception | – | – |
| Preview | `/state`, 4 s later | – | 1 | the time, 3.9 s overdue |
| Preview | `/remind` again, 1.5 s ahead | `set`, no error | – | – |
| Preview | a new Build, then `/state` 3 s later | – | 2 | the second time, as version 2 |
| Preview | `/state`, 65 s later | – | 2 | the same time, 68 s overdue |
| Deployment | `/remind`, 300 ms ahead | `500 The app threw an error: Error: Facets currently cannot set alarms.` | – | – |
| Deployment | `/state` straight after | – | 1 | the time |
| Deployment | `/remind` again, 300 ms ahead, 3 s later | `200 set` | – | – |
| Deployment | `/state`, 72 s after the alarm's time | – | 2 | the time, still pending |

- **The refusal is the same:** workerd's message, failing the first call. That's the call that adds an alarm to an instance with none.
- **Unlike locally, nothing is lost.** The failing call's write is kept, and so is the time, which `getAlarm()` then reads back. A later `setAlarm` on the same instance succeeds without an error. So an app sees an alarm that seems set, and never rings.
- **`alarm()` never ran,** in either slot, though Cloudflare says an alarm can be up to a minute late: no "rang" row, and no alarm event in the tail at the Preview's two alarm times. The tail stopped capturing at 18:14:32, before the Deployment's alarms were due.
- **After a new Build,** the pending time stayed with the instance, and version 2 read it. It never rang either.
- **Not checked deployed:** the app host keeping alarms, and running a schedule. Both need the probe branch's platform code, so they get checked in the spec's first slice.

### Recommendation

**Give an app's Durable Objects alarms, through the app host, with Cloudflare's own API.** The Agent writes `this.ctx.storage.setAlarm(...)` and `alarm()` as Cloudflare's docs show them. A reminder "the day before the run" is an alarm on the run's instance. A weekly rota is an `alarm()` that sets the next week's alarm. The Agents SDK's `this.schedule()` is built on alarms too. Cron triggers can come later on the same table, if an app needs them; the probe shows they work.

1. **The instance's own storage holds its alarm.** The wrapper (`src/apphost/app-data.ts`) defines `setAlarm`, `getAlarm` and `deleteAlarm` on each instance's `ctx.storage`. They write and read the time under a platform-named key in the instance's own storage. That key commits with the call's other writes, or is lost with them, and `deleteAll()` clears it, as on Cloudflare. `setAlarm` also tells the app host the time, through `AppData`, with the instance's binding and ID from `ctx.props`. The probe sent the time to the app host alone, so a call that failed after `setAlarm` would still have rung.
2. **The app host's row only wakes the instance.** It keeps one row per instance with a time: slot, binding, ID, name and when. Its own alarm is set for the earliest of those and of the retired Secrets'. `retireSecret` sets the alarm only when none is pending, so it changes to setting it for the earliest due time. When the alarm rings, the app host calls each due instance's platform-named method. That method rings `alarm()` only if the instance's own stored time is due, so a wake for a failed call, a deleted alarm or `deleteAll()` does nothing. The app host deletes its row only after the call returns, and only if the time hasn't changed meanwhile. So an alarm isn't lost if the app host stops mid-ring, and an `alarm()` that sets the next one keeps it.
   - **Open for the spec: the commit protocol between the two objects.** Cloudflare's guarantee is at least once, and this design doesn't yet give it. Codex's third review found two gaps.
     - **Retries:** a ring that fails, or that an abort cuts off, needs an in-flight state the retry recognises, while `getAlarm()` reads `null` during `alarm()`, as on Cloudflare.
     - **Two commits:** the instance's key and the app host's row commit separately. A failed call to `AppData` that the app catches leaves a time with no wake. A wake can come while the call that set it is still running, before its writes commit. A reconciliation rule could cover both, such as the instance reporting its committed time back on each wake, and the app host re-reading it.

3. **Data and code** follow ADR 0015: rows are per slot, an alarm rings with the slot's current code, and deleting the Workspace deletes the rows. `deleteAll()` has deleted the alarm itself since compatibility date 2026-02-24, and the platform's is 2026-10-01.
4. **The Preview and the Deployment:** each slot's alarms ring by themselves, as each slot's data is its own. That's how the Developer sees a reminder work. But Secrets are shared (ADR 0016), so the Preview's alarms send real email from its test data. The alternative is that the Preview's alarms ring only when the Developer or the Agent asks, through a tool beside `request_preview`. That choice is Jack's (below).
5. **Limits,** so an app can't run constantly:
   - An alarm sooner than a minimum interval from now, such as one minute, rings at that interval instead. A loop of alarms then can't ring more often than that.
   - Each slot has a cap on pending alarms, such as 1,000, and `setAlarm` past it throws, with a message saying why.
   - Each ring has the app's existing limits (`appLimits`: 10 s of CPU, 50 subrequests) and a wall-time deadline. Rings run one at a time, or a few at once, so one app's backlog can't hold the app host's alarm for long.
   - Retries: Cloudflare retries a failed `alarm()` up to 6 times, with backoff. The app host catches each ring's error, logs it in the slot's logs, and retries it a few times with backoff, as a row of its own. A failing app then can't delay the retired Secrets' clean-up or other instances' alarms.
   - A ring that a new Build, a publish or new Secrets cut off (the app host aborts the slot's instances) counts as failed, and is retried.
6. **Reminders** then come as an add-on: storing what to remind whom of and when, setting the alarm, and sending with the email add-on.
7. **ADR 0015** needs a new decision, since it lists alarms as not supported. The Templates' notes should say alarms work. A test pins each facet behaviour the design relies on: defining methods on `ctx.storage`, `ctx.props` reaching the instance, and calling `alarm()` under another name. Tests cover a call that fails after `setAlarm`, `deleteAll()`, and an app host that stops mid-ring.
8. **Words:** "alarm" is Cloudflare's word and the code's. If the page needs to speak of one, "reminder" or "a time the app wakes up" goes in the glossary's "Words on the page" first.

**Not recommended:**
- **Cron triggers first.** They work through the app host too (above). But "the day before each run" would mean polling every few minutes, and they need a cron parser, time zones (cron is in UTC, so "9am every Monday" moves by an hour in summer time), and their own limits. Add them if an app needs a fixed timetable that an alarm handler can't keep.
- **The app host calling a route,** such as `POST /__scheduled`. Anyone with the app's URL could call it unless the wrapper blocks it, and it isn't how a Worker is written.

**For Jack, in the spec:**

| Decision | Recommendation | Why |
| --- | --- | --- |
| Alarms or cron triggers first | Alarms through the app host | Cloudflare's API, per instance, fits reminders; cron can follow |
| The Preview's alarms | Ring by themselves | The Developer sees a reminder work, as they will in the Deployment; the cost is real email from test data |
| Minimum interval | 1 minute | Fine for reminders; caps a loop at 1,440 rings a day per instance |
| Pending alarms per slot | 1,000 | Room for one per event or person in a small app |

### Found along the way

- **Nothing tells the Agent that `setAlarm` fails.** The Templates' notes list KV, D1, R2, queues and cron triggers as unavailable, but not alarms. An Agent that sets one writes an app whose first call fails with workerd's message. Deployed, later calls then seem to set it, and it never rings. Left for the spec, which changes those notes anyway.

## Live updates over WebSockets (#109)

**Verdict: an app's page can't hold a WebSocket into one of its Durable Objects today, locally or deployed, but locally a small platform change makes it work, with hibernation.** The instance takes the upgrade, but the stand-in sends `fetch` to the app host by RPC, and RPC can't carry a WebSocket, so the app gets `DataCloneError`. In a probe, the stand-in sent upgrades over `fetch` instead. Then sockets worked in the Preview and the Deployment, apart from each other. A message reached every open socket at once, an idle instance hibernated and woke on the next message, and a new Build or publish dropped that slot's sockets, once the app host aborted every instance in its `facets` table. The deployed platform refuses in the same way. Whether facets hibernate on Cloudflare, rather than in workerd, is undocumented, and is for the spec.

### How it was measured

- **Locally:** the platform's vitest pool, workerd 1.20261006.1 (wrangler 4.149.0), on 2026-11-09, on a shared development machine.
- **The app:** one binding, `ROOM`, to a `Room` class. Its `fetch` accepts an upgrade either with hibernation (`ctx.acceptWebSocket`) or with `accept()`, and greets the socket. `webSocketMessage` sends what it heard to every socket in the instance, and an RPC method `broadcast` does the same from an ordinary request. The constructor counts its starts, with their times, in the instance's storage, and sets an auto-response, `ping` to `pong`. The app's Worker forwards `/socket` to `env.ROOM.getByName(room).fetch(request)`. It's `test/websocket-probe.test.ts` on the branch `109-websockets-probe` (`0e941bb`), which isn't for `main`.
- **Upgrades over `fetch`:** on the same branch, the wrapper's stand-in (`src/apphost/app-data.ts`) sends a `fetch` with `Upgrade: websocket` to `AppData`'s `fetch` handler, with the binding, the ID and the original URL in a header. `AppData` adds the slot and passes it to the app host's `fetch`, on a hostname outside the apps domain, which the platform Worker never sends to an app host (`src/platform/worker.ts`). The app host calls the facet's `fetch` and returns its `101` as it is. Other calls still go by RPC.
- **The browser's side:** each test opened sockets as a browser would, through the platform Worker, with the Preview's session cookie or an Access token for the Deployment, and `Origin` set to the app's own.
- **Source and docs,** read on 2026-11-09: workerd at `v1.20261006.1` (`107ea005`) and at `main` (`95fcc068`), Cloudflare's docs at `85a909ff` of `cloudflare/cloudflare-docs`, and the Agents SDK's `design/sub-agent-routing.md` at `c2a7bc54` of `cloudflare/agents`.

### Today: an upgrade forwarded to an instance

| Case | What the browser got | The instance |
| --- | --- | --- |
| Hibernation (`acceptWebSocket`) or `accept()`, in the Preview | `500`, from the probe app's catch: `DataCloneError: Could not serialize object of type "WebSocket". This type does not support serialization.` | started once, and its code accepted the socket |

- **Why:** the facet's own `fetch` returns the `101`, but the app host returns it to `AppData`, and `AppData` to the app, by RPC. `Response`'s serialiser includes its `webSocket`, and `WebSocket` isn't serialisable (`src/workerd/api/http.c++`, whose comment says "we could add support for sending it over RPC in the future"; `src/workerd/jsg/ser.c++`). The Agents SDK says the same: "WebSocket handles cannot be serialized over RPC". The instance is left holding a socket nobody can reach.
- **Only the Preview was measured;** the Deployment's stand-in is the same code.
- **An app's Worker can hold a socket of its own,** with `new WebSocketPair()`, and the app host passes it through (`test/preview.test.ts`). But it can't reach other pages' sockets: they're held by other requests, in isolates that may be on other machines. So it isn't a way to live updates.
- **`test/app-data.test.ts` pins this,** and the stranded socket: if a workerd upgrade lets RPC carry a WebSocket, it fails.

### Upgrades over `fetch` (probe)

| Case | Result |
| --- | --- |
| Two sockets with hibernation, one sends `x` | both got `heard x` |
| A `broadcast` from an ordinary request | answered `2`; both sockets got it |
| The same with `accept()` | the same |
| The Deployment, published, one socket in the same room | the Preview's `broadcast` reached 2 sockets, the Deployment's 1 |
| 200 sockets in one instance, then a `broadcast` | answered `200`; all 200 got it |
| Messages of 1, 4, 16 and 33 MiB from the browser's side | each reached `webSocketMessage` whole |

- **The app's code is Cloudflare's own:** `stub.fetch(request)` from the Worker, and `ctx.acceptWebSocket`, `getWebSockets()`, `webSocketMessage` and `setWebSocketAutoResponse` in the instance.
- **The app host only passes the socket on.** It returns the facet's `101` without accepting it, which workerd pumps after the app host's request has finished (`src/workerd/api/web-socket.c++`, "allow the IoContext to go away"). Whether Cloudflare bills the app host's duration while it passes a socket on is undocumented.
- **33 MiB went through locally,** past Cloudflare's documented 32 MiB for a received message. The limit wasn't hit on this path in workerd.

### New code, and the Preview apart from the Deployment

| Case | The Preview's sockets | The Deployment's sockets |
| --- | --- | --- |
| A new Build, the instance awake | closed, `1006` "WebSocket disconnected without sending Close frame.", within 228 ms of starting the save and the Build | stayed open; its `broadcast` still reached it |
| A publish | – | closed, `1006` |
| After that Build, a `broadcast` in the new code | reached `0`: no socket, by hibernation or `accept()`, outlived the abort | – |
| A new Build after 15 s idle, the instance hibernated | **stayed open**, and the instance ran the old code: for its next message, and for a `broadcast` from the new Build's Worker | – |
| The same, with the app host aborting every facet in its `facets` table | closed, `1006`; the new code's `broadcast` reached `0` | – |

- **Why:** the app host aborts a slot's facets for new code (ADR 0015), and an abort drops the facet's hibernation manager with it (`server.c++`, `legacy-hibernation-manager.c++`). New Secrets abort both slots' facets the same way, so they'd drop both slots' sockets (from the code, not measured).
- **A hibernated instance escapes new code today.** The app host aborts only the facets in `running`, which it keeps in memory (`abortFacets`, `src/apphost/index.ts`). After 15 s idle the app host had also been evicted (inferred), so `running` lacked the facet's name, and the instance, woken by its socket from the class workerd had cached, went on running the old code. Without sockets that can't happen, since a facet's alarms never ring (#107): an instance is only ever woken by the app host, which starts it with the slot's current code.
- **A platform deploy** restarts the app host, and Cloudflare closes a Durable Object's sockets when it shuts down (inferred: its docs say hibernated sockets survive a code update only when the object is hibernated, and every socket here passes through the app host).
- **So a page must reconnect,** and ask again for what it shows, as any socket does after a network change.

### Idle sockets

| Case | Constructor starts | What came back |
| --- | --- | --- |
| Hibernation, idle 75 s, then a message | 2: it restarted to take the message | `heard wake` |
| `accept()`, idle 75 s, then a message | 1: it stayed in memory | `plain wake` |
| Hibernation, idle 15 s, then `ping`, 3 s later a message | 2, the second at the message, not at `ping` | `pong`, then `heard q` |

- **The facet hibernated:** it had restarted by the first message, 18 s after the socket opened, and workerd's code shuts an idle facet down after 10 s. The hibernation manager handed its sockets to the restarted instance. The auto-response answered without waking it.
- **The restarted instance kept its ID,** name and all (`ctx.id.name` read `h` before and after), although workerd restarts it from the class it cached, without the app host's callback (`server.c++`).
- **On Cloudflare, nothing says facets hibernate.** The facets page and the Agents SDK's sub-agents page say nothing about WebSockets in a facet. workerd's comments say "embedders running facets are expected to supply a token" for it (`src/workerd/io/worker.c++`). The Agents SDK doesn't rely on it: its root object keeps the socket and forwards each frame to the sub-agent by RPC, so every frame wakes the root.

### Limits

- **Sockets:** 32,768 per instance with hibernation, Cloudflare's. 200 in one instance worked locally. An app's instances are all facets of its app host, each with a hibernation manager of its own; whether Cloudflare counts their sockets together is undocumented.
- **Idle time:** sockets stayed open through 75 s idle locally, the longest measured. Cloudflare's Durable Object docs give no idle timeout for a socket, and an auto-response keeps one busy without waking the instance. An instance with only hibernated sockets hibernates after 10 s; one that `accept()`ed stays in memory, billed for duration, while any socket is open.
- **What an app can send:** a received message up to 32 MiB, 30 s of CPU per message, an attachment of 16 KiB per socket, 10 tags of 256 characters, and an auto-response of 2,048 characters each way (Cloudflare's limits and state pages, and workerd). Messages from the instance to the browser aren't billed; messages to the instance are billed as requests, 20 to 1.
- **Past the platform Worker:** once upgraded, messages go straight to the instance. The platform Worker sees only the upgrade, so the Preview's rate limits (#113) count the upgrade but never a socket's messages.
- **Polling, for comparison:** the `live` add-on asks every 5 s, and every 30 s while nothing changes. That's 120 to 720 asks an hour for each open page, each through the platform Worker, the app host, the app's Dynamic Worker and, for data, `AppData` and the instance. A socket costs one upgrade per page, then one message per change, and nothing while idle if the instance hibernates.

### Deployed

**The deployed platform refuses the same way.** Checked on 2026-11-09 from the Developer's signed-in browser, in a T3 preview tab, with the tail running. The Workspace was made for the check through the API, from the Worker Template with the test app's two files: one binding, `ROOM`, to a `Room` class that accepts an upgrade with hibernation or `accept()`. It was built, published, and deleted afterwards.

| Case | Preview | Deployment |
| --- | --- | --- |
| The app's Worker calls `room.fetch` with `Upgrade: websocket` and catches | `refused: DataCloneError: Could not serialize object of type "WebSocket". This type does not support serialization.`, in both modes | the same |
| The browser's `new WebSocket` to a route that forwards to `room.fetch` | `error`, then close `1006`, in both modes; the platform Worker answered `500` (tail, 56–59 ms wall) | the same (`500`, 117–139 ms wall) |
| The instance afterwards | `getWebSockets().length` read 1: the stranded socket | 1 |
| The app's Worker's own `WebSocketPair`, echoing | open in 1,399 ms (the first), echo 16 ms later, clean close | open in 782–821 ms, echo 10–17 ms later, clean close |

- **The Preview's logs** showed each refusal as `server exception DataCloneError: ...`, so the Agent and the Developer see why.
- **Upgrades pass both apps-domain Access applications:** the Preview's own session, and the Deployment's Access cookie.
- **Upgrades over `fetch`, and so hibernation in a facet, weren't checked deployed.** They need the probe branch's app host, and a Preview runs only an app's code, so checking them would mean deploying the platform. That's for the spec (below).

### Recommendation

**A platform change first, then live updates in the `live` add-on.** Polling (#108) works (Limits, above). Sockets would show changes at once and cost nothing while idle, but only once the platform passes upgrades through, and only if facets hibernate on Cloudflare.

1. **Check facet hibernation on Cloudflare first,** since the design depends on it. A small probe Worker, outside the platform, can show it in an hour: a Durable Object running a Dynamic Worker's class as a facet that accepts a socket with hibernation, idle past 10 s, then a message. The trace shows whether the facet restarted to take it, and whether the parent stayed active meanwhile. That's a new Worker on Jack's account, so it's Jack's to approve (below). The alternative is to check it in the spec's first slice, on the deployed platform.
2. **The platform change:** the stand-in sends an upgrade over `fetch`, on a hostname outside the apps domain, as the probe did, and new code aborts every one of the slot's facets in the `facets` table, as `remove` deletes them, not only those in `running`. That's about 35 lines. RPC stays for everything else. A test pins that a browser request can't reach that path: the platform Worker sends an app host only hostnames on the apps domain. ADR 0015 gets a new decision, since it lists WebSockets into an instance as not supported, and the Templates' notes say sockets work through `stub.fetch`.
   - **If facets don't hibernate on Cloudflare,** the app host keeps the sockets instead, with hibernation, tagged with the slot, binding and ID, and passes each message to the instance by RPC, as the Agents SDK does. The instance sends through the wrapper. That's more code, and every message wakes the app host, so the add-on would still send messages only one way.
3. **The add-on:** `live` keeps its routes and ETags, and its notes' pattern. The store's instance tells its sockets which collection changed, and the page asks that collection's route again. The page sends nothing over the socket: changes stay ordinary requests, so they keep the platform's `Origin` checks and the Preview's rate limits (#113). While the socket is down, the page reconnects with backoff, asks again once connected, and polls slowly meanwhile. That covers each Build, publish, Secrets change and platform deploy, which drop the sockets.
4. **Limits:** a cap on sockets per instance, such as 1,000, in the wrapper's `acceptWebSocket`, with a message saying why. Cloudflare's own limits cover the rest. Deployments open to everyone (`DEPLOYMENTS_OPEN_TO_EVERYONE`) could otherwise have one page open sockets without end.
5. **Tests** pin each behaviour the design relies on: an upgrade reaching an instance in each slot, the slots apart, a new Build or publish dropping only its own slot's sockets, hibernated or not, and hibernation where the vitest pool can show it.

**Not recommended:**
- **A live-updates add-on now.** Nothing an add-on can write reaches an instance with a socket today.
- **Sockets in the app's Worker,** with no Durable Object. They can't reach each other's pages (above).
- **Leaving it at polling,** unless the deployed check finds facets don't hibernate and the app host's way costs too much. Polling stays the fallback in the add-on either way.

**For Jack, in the spec:**

| Decision | Recommendation | Why |
| --- | --- | --- |
| Check facet hibernation before the spec | Yes, with a small probe Worker on Jack's account, deleted after | The design depends on it, and it's undocumented; an hour's work |
| Platform change first, or an add-on now | Platform change first: upgrades over `fetch`, and aborting every facet | Today no socket reaches the app; the probe's change is about 35 lines |
| What a socket carries | Only which collection changed; the page asks its route | Changes keep the platform's checks and rate limit; reuses `live`'s routes |
| Polling | Kept, slowly, while the socket is down | Sockets drop on each Build, publish, Secrets change and deploy |
| Sockets per instance | Capped at 1,000 | Well above a small app's use; stops one page opening them without end |

### Found along the way

- **Nothing tells the Agent that sockets fail.** The Templates' notes don't mention WebSockets. An Agent that forwards an upgrade to a Durable Object writes an app whose `fetch` fails with `DataCloneError`. Left for the spec, which changes those notes anyway.

## The Preview's errors after each Build (#45)

**Verdict: yes.** On the deployed platform, the Agent saw its app's error twice without asking for the logs: in the `build` tool's result, and when the Turn ended. It then fixed the app. The Turn took one retry for it, and $0.11.

- **Platform:** the deployed platform at `main` (`00e3e43`, with #115), checked on 2026-11-09 from the Developer's signed-in browser (Chrome, T3's preview tools) in the UK, with `wrangler tail` running.
- **Turns:** one Turn of Opus 5.5, in a Workspace made for the check from the Worker Template and deleted afterwards. The budget was $1; it cost $0.113 at the tail script's prices.
- **The request** spelt out the steps, since a Developer wouldn't break their own app: make the home page throw "The list is missing", build it and say what the build said; change the error to "The list is still missing" without building; and fix the home page if the platform then reports errors.

**What the Agent was given:**

| When | What it read |
| --- | --- |
| The `build` tool, after the first change | "The Build succeeded. The platform tried the Preview with GET /, which answered 500. Since this Build, it has logged 1 error: … server error: Error: The list is missing" |
| The Turn's end, after the second change, which it didn't build | "After your Turn, the Preview logged 1 error when the platform tried it. Fix any that need it. If none do, change nothing and end your Turn. This is retry 1 of 3." and the same report, with "The list is still missing" |
| The `build` tool, after its fix | "… which answered 200. It has logged no errors or warnings since this Build." |

- **The page** showed "Tried your app and found a problem, looking into it (try 1 of 3)" between the Agent's two replies.
- **The Agent's replies** were plain: the first said opening the home page "gave a server error, and the app's log recorded one error"; after the fix, that the home page "opens with no errors, and nothing was recorded in the app's log".
- **Only the new Build's lines:** each report had only its own Build's error, not the earlier one.

**The Turn's log line:** completed, 40.3 s, 10 steps, 1 retry, no Check or Build errors, the tests passing; `previewTries` 3, `previewErrors` 2, `previewWarnings` 0 and `previewRetries` 1.

**What the tries cost in time:** each sends `GET /`, then waits 3 s. The Agent's two Builds took 10.0 s and 9.3 s of wall time, with the try inside their trace, against 5.3 s for the Turn's own Build, whose try runs outside it. So a try added about 4 s. A Build the Agent had already seen tried, such as the Turn's cached Build after the fix, isn't tried again: that trace took 0.8 s.

**Not covered:**
- **Front-end errors from an open Preview pane:** the Worker Template has no front end. The Workspace page, with its Preview pane, was open during the Turn.
- **Warnings,** and the Agent judging one harmless: covered only by the scripted model's tests (`test/preview-errors.test.ts`).
- **`request_preview` beyond `GET /`:** the Agent didn't call it. The only route it changed was `GET /`, which the platform's tries covered.
