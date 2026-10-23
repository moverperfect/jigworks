# 02: Probe: Check, Build and run in one Durable Object

**Parent:** [spec](../spec.md), user stories 3 to 7 (stage 1)

**What to build:** A throwaway Worker on `workers.dev`, behind Access. For each of its built-in test projects, its one Durable Object runs a ts-rust Check, builds the project with `@cloudflare/worker-bundler`, and loads the Build into a Dynamic Worker. It reports the memory, CPU and time each step took. This answers stage 1: do the riskiest parts fit in one isolate? It also sets up the platform repo and the Checker and Builder modules that later tickets reuse.

**Blocked by:** 01 (Build ts-rust's WebAssembly module).

**Status:** resolved

- [x] The platform repo is a pnpm project with wrangler and vitest, using `@cloudflare/vitest-plugin`, and its first test passes.
- [x] The Checker takes a snapshot of files and Packages and returns diagnostics with file, position, code and message. A test project with a known error returns that error.
- [x] The Builder wraps worker-bundler unmodified. A Build whose output still imports a package that couldn't be found fails, with an error naming the package.
- [x] A Build of each test project loads into a Dynamic Worker and answers a request.
- [x] The test projects are a Worker project and a Worker + React project without Tailwind. Their Packages are included in the probe, and the probe takes no code from requests.
- [x] The probe reports, for both cold and warm Checks and Builds, CPU time, elapsed time and peak memory, as Cloudflare reports them. It also reports how long the Worker takes to start with both WebAssembly modules loaded.
- [x] A note records whether Dynamic Workers and Durable Object facets run under the local vitest integration.
- [x] The probe refuses every request without a valid Access token, so it is closed even before Access is turned on.
- [x] The probe is deployed on `workers.dev` with Access turned on. The agent asks before deploying.
- [x] The findings document exists and holds the stage 1 verdict. The pass bar:
  - no out-of-memory errors or stack overflows;
  - Checks under 3 s for the Worker project and under 10 s for the Worker + React project.

  Slower but working counts as "yes, with a caveat".

## Tasks

1. Set up the platform repo: pnpm, wrangler, and vitest with the Cloudflare plugin. Later tickets build on this.
2. Checker module.
3. Builder module, including the check for packages that couldn't be found.
4. Load a Build into a Dynamic Worker and call it.
5. Built-in test projects for both Templates.
6. Measure memory, CPU, elapsed time and startup.
7. Find out whether Dynamic Workers and facets run under local vitest.
8. Deploy to `workers.dev` behind Access. Jack turns on Access.
9. Write the stage 1 verdict.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-13, agent:** Built and tested locally (16 tests), then deployed with Jack's go-ahead.

- vitest is 4.1.11. `@cloudflare/vitest-plugin` 1.4.0 fails every test under vitest 5.0.4 on Windows ("File path must be a file: URL"), even though it declares vitest 5 support.
- **Local note:** Dynamic Workers and Durable Object facets both run under the local vitest integration. The tests load both test projects into Dynamic Workers and run a Durable Object class from a Dynamic Worker as a facet with its own storage.
- Memory: workerd doesn't report per-request memory. The probe reports each WebAssembly module's linear memory after each step, which never shrinks, so it is the step's peak. The Tail Worker records Cloudflare's outcome, which shows exceededMemory if a step hits the 128 MB limit. The JavaScript heap isn't covered.
- CPU and wall time come from the probe's Tail Worker, because in-code timers don't advance during pure CPU work.
- Deployed on `workers.dev`, 33.5 MB upload (8.4 MB gzip), **Worker startup time 25 ms** with both WebAssembly modules. It refuses every request (403) until the Access settings are filled in.

**2026-10-14, agent:** Measured and resolved. The stage 1 verdict is in `docs/findings.md`: **yes, with a caveat**.

- Slowest Check: 443 ms CPU, against bars of 3 s and 10 s. Builds: 155-579 ms. Startup: 25-29 ms.
- **Caveat:** ts-rust and esbuild don't fit in one isolate together, and neither do two ts-rust runs in one request. Cloudflare reports no error; it replaces the isolate after the request. Checks run in a Dynamic Worker, one RPC call per tsconfig, keep the Durable Object's isolate stable. This contradicts the Q18 decision (ts-rust inside the Workspace's Durable Object), so it needs Jack's decision before tickets 05 and 06.
- Peak memory isn't something Cloudflare reports. The probe reports WebAssembly linear memory, and isolate IDs show when the limit was hit.
