# Jigworks: develop entirely in Workers isolates

Status: ready-for-agent

## Problem Statement

Developers build applications either on their own machine or on a cloud agent that has a real filesystem and shell. Either way, editing, type-checking, building, running and hosting the code all need a full machine, local or rented. Nobody knows whether Cloudflare's Workers isolates could do all of that instead. Organisations already on Cloudflare pay for them. If they can, a Developer needs only a browser, and the Agent works in the same place the app is hosted.

## Solution

Jigworks is a browser-based platform, installed on an organisation's own Cloudflare account, where a Developer and the Agent build Cloudflare Workers and React front-ends together. Every step runs in Workers isolates. There are no containers (ADR 0001).

- The Developer signs in, creates a Workspace from a Template, and either chats with the Agent or edits files in the browser.
- The Agent changes files during a Turn. ts-rust, compiled to WebAssembly, checks them (ADR 0002).
- Cloudflare's bundler builds the files inside the Workspace's own Durable Object.
- The latest Build runs as the Preview on a Dynamic Worker, where the Developer and the Agent try it out.
- The Developer publishes a Build as the Deployment, which anyone the apps' Access application lets in can open.

This is an experiment, built in stages. Each stage ends with a verdict in the findings document: yes, yes with a caveat, or no. The verdict comes with measurements and every gap found.

The finish line is reached when a Developer signs in and asks for a small Worker, and all of the following happens in isolates:
- the Agent writes it;
- the Check comes back clean;
- it's built, run and tried out;
- it's hosted at a URL.

## User Stories

### Running the experiment

1. As the experimenter, I want ts-rust's WebAssembly module built from a pinned commit by a script kept in the repo, so that every measurement uses a known checker.
2. As the experimenter, I want to rebuild the module only when I move the pin, so that results stay comparable between stages.
3. As the experimenter, I want a probe that runs a Check, a Build and the resulting code inside one Durable Object, so that I learn early whether the riskiest parts fit in an isolate.
4. As the experimenter, I want the probe to report peak memory, CPU time and elapsed time for each step, so that I can judge them against the pass bar.
5. As the experimenter, I want the probe to measure how long the platform Worker takes to start with both WebAssembly modules loaded, so that I know whether it fits Cloudflare's 1-second startup limit.
6. As the experimenter, I want the probe to run only its built-in test projects, behind Access, so that nobody can use it to run their own code.
7. As the experimenter, I want each stage's verdict, measurements and gaps written to the findings document, so that the experiment's result is clear at the end.
8. As the experimenter, I want every Check's timings logged, so that I can compare real Workspaces with the pass bar.
9. As the experimenter, I want every bundler gap, Package version conflict and Tailwind failure counted, so that the findings show how often the toolchain fell short.
10. As the experimenter, I want the Agent's model set by a configuration variable, so that I can switch models without a code change.

### Workspaces

11. As a Developer, I want to sign in through Access, so that only the Installation's Developers can reach the platform.
12. As a Developer, I want a home page listing my Workspaces, so that I can pick up where I left off.
13. As a Developer, I want to create a Workspace from the Worker Template or the Worker + React Template, so that I start from something that already builds.
14. As a Developer, I want to export a Workspace as a zip, so that I have a backup of its files.
15. As a Developer, I want to delete a Workspace by typing its name, so that I can't delete one by accident.
16. As a Developer, I want deleting a Workspace to take its Deployment down and delete its app data, so that nothing is left running.
17. As a Developer, I want a Workspace page with a file tree, one editor, a problems list and the Conversation, so that I can see everything about the Workspace at once.
18. As a Developer, I want to open, edit and save a file in the editor, so that I can make changes myself.
19. As a Developer, I want a Check to run shortly after I save, so that the problems list stays current without my asking.
20. As a Developer, I want a Build to run when I save, so that the Preview shows my change.
21. As a Developer, I want Packages and attachments kept out of the file tree, so that it shows only my code.

### Packages

22. As the Agent, I want to add a Package by name and get the newest version that's at least a day old, so that I don't guess versions from memory.
23. As the Agent, I want the Package's exact version written into `package.json`, so that the Workspace records what it depends on.
24. As a Developer, I want my own edits to `package.json` to install or remove Packages before the next Check or Build, so that hand edits work too.
25. As a Developer, I want a Package's own dependencies to resolve the same way until `package.json` changes, so that the same files always give the same Check.
26. As a Developer, I want version conflicts between Packages shown as warnings in the problems list, so that I know when a Package got a version it didn't ask for.
27. As a Developer, I want peer dependencies whose versions don't fit shown as warnings, so that a mismatch doesn't stay hidden.
28. As a Developer, I want versions published less than a day ago refused, so that a freshly compromised release can't reach my Workspace.

### Turns

29. As a Developer, I want to send the Agent a message and watch its Turn as it happens, so that I can follow what it's doing.
30. As a Developer, I want the editor locked while a Turn runs, so that my edits and the Agent's never collide.
31. As the Agent, I want to be told which files the Developer changed since my last Turn, so that I don't overwrite their work.
32. As a Developer, I want the Conversation kept across visits, so that the Agent remembers what we've done.
33. As a Developer, I want to start fresh, so that a long Conversation doesn't slow the Agent down.
34. As a Developer, I want every Turn to end with a Check and then a Build, retried up to 3 times between them, so that the Agent hands back code that type-checks and runs.
35. As the experimenter, I want each Turn capped at 40 steps, so that a confused Agent can't run up a large bill.
36. As the Agent, I want to read, write, edit, list and search files, so that I can change the Workspace.
37. As the Agent, I want a bash shell over the Workspace's files, so that I can use familiar commands.
38. As the Agent, I want a `check` tool that returns the current errors, so that I can fix them before the Turn ends.
39. As the Agent, I want a `build` tool that returns Build errors, so that I can fix them before the Turn ends.
40. As the Agent, I want the Workspace's `AGENTS.md` in my instructions on every Turn, so that I follow what this platform's Build needs.

### Builds

41. As a Developer, I want a Build to go ahead even when the Check shows errors, so that I can try out half-finished code.
42. As a Developer, I want the Preview to keep the last good Build when a Build fails, so that a mistake doesn't take it down.
43. As the Agent, I want a Build to fail when its output still imports a Package that couldn't be found, so that silent breakage becomes an error I can see.
44. As a Developer, I want unchanged files never rebuilt, so that Builds stay quick.
45. As a Developer using the Worker + React Template, I want Tailwind classes to work, so that I can style pages the way the Agent writes them.
46. As a Developer, I want my app built with the compatibility settings and bindings in its `wrangler.jsonc`, so that it behaves as configured.

### Preview

47. As a Developer, I want a Preview pane on the Workspace page, so that I can try the app next to the code.
48. As a Developer, I want to open the Preview in its own tab, so that I can use it at full size.
49. As a Developer, I want the Preview's server logs and front-end errors shown next to it, so that I can see why something broke.
50. As a Developer, I want only me to be able to open my Preview, so that unfinished work isn't exposed.
51. As a Developer, I want the Preview and the Deployment to keep responding while the Agent checks or builds, so that my work never stalls them.
52. As the Agent, I want to send requests to the Preview and read the responses, so that I can try my code.
53. As the Agent, I want to read the Preview's server logs and front-end errors, so that I can find out why a request failed.

### Deployment

54. As a Developer, I want to publish the current Build as the Deployment with a button, so that others can use the app.
55. As a Developer, I want the Deployment to stay unchanged until I publish again, so that my Preview work doesn't affect users.
56. As a Developer, I want the Deployment at a readable hostname on the Installation's apps domain, so that I can share the link.
57. As someone the Installation lets in, I want to open a Deployment by signing in with my organisation's account, so that I can use apps colleagues have built.
58. As a Developer, I want my app to store data in Durable Objects through a binding, so that it can keep state.
59. As a Developer, I want the Preview's data kept apart from the Deployment's, so that trying things out can't damage live data.
60. As a Developer, I want to give my Workspace secrets that my app reads from `env`, so that it can call APIs that need keys.
61. As a Developer, I want the Agent to see only my secrets' names, so that it never sees their values.
62. As a Developer, I want my app to call external APIs, so that it can integrate with other services.
63. As the experimenter, I want apps limited in CPU time and outgoing requests, so that a runaway app can't burn through the account's quota.
64. As someone the Installation lets in, I want apps never to see my Access token or other sites' cookies, so that an app can't act as me elsewhere.
65. As a Developer, I want the platform to refuse requests that come from apps, so that an app can't act in my name on the platform.

### Tests

66. As the Agent, I want a `test` tool that runs vitest-style test files against the Workspace's code, so that I can check behaviour as well as types.
67. As the Agent, I want `describe`, `it`, `expect`, `vi.fn`, `vi.spyOn` and fake timers to behave as they do in vitest, so that tests written the usual way work.
68. As a Developer, I want tests to run at the end of every Turn, with results in the problems list, so that I always know whether they pass.
69. As the Agent, I want failing tests not to force a retry, so that I can write a test that fails before I make it pass.
70. As a Developer using the Worker + React Template, I want to test logic and server-rendered HTML, so that the front-end isn't untested.

## Implementation Decisions

### Stages and pass bar

0. **Build the ts-rust WebAssembly module.**
   - It's built on a Linux build machine with at least 8 GB and 8 CPUs.
   - The build uses ts-rust commit `5879a56`, with rustup (`wasm32-wasip1` target), Node 22 and binaryen 132 or later, all installed in the home directory.
   - The `.wasm` file is kept in the repo with its build script.
1. **The probe.** One Durable Object runs a ts-rust Check, a Build, and the result loaded into a Dynamic Worker.
   - It passes if nothing runs out of memory or overflows its stack, and Checks take under 3 s for the Worker Template and under 10 s for Worker + React. Slower but working counts as "yes, with a caveat".
   - It also measures platform Worker startup with both WebAssembly modules loaded, and checks that ts-rust and esbuild fit in one isolate.
2. **Workspaces, the editor and Access.**
3. **The Agent and the Check loop.**
4. **Builds and the Preview.**
5. **Hosting (Deployments).**
6. **Tests.**

### Platform shape

- **One platform Worker** serves the single-page app and its API at the platform's hostname, and apps on the Installation's apps domain (ADR 0012).
- **Three Durable Object classes**, with Durable Object SQLite as the only storage (ADR 0004):
  - **Workspace:** a Think agent holding the files, the Conversation, the Packages and their resolved versions (ADR 0003).
  - **App host:** one per Workspace, holding Builds, the Preview, the Deployment, app data and logs (ADR 0009).
  - **Developer:** one per Developer, listing their Workspaces.
- **The single-page app** is React and Vite, served by the same Worker behind Access. The platform itself is developed on a laptop in the usual way; only Workspaces live in isolates.

### Modules

- **Checker.**
  - Input: a snapshot of a Workspace's files and Packages. Output: diagnostics (file, position, code, message) and timings.
  - It wraps the ts-rust WebAssembly module with a synchronous filesystem over the snapshot. The Workspace's Durable Object runs it in a Dynamic Worker, one call per tsconfig, sending only the files a Check reads (ADR 0010).
  - It skips `/attachments/`.
- **File store.**
  - Our own interface in front of Cloudflare's file store, which is called `files` in code. When Think moves from `@cloudflare/shell` to `@cloudflare/computer`, only this module changes.
  - It gives the Checker and the Builder a synchronous snapshot.
  - It hides `/attachments/` from the file tree, the zip and the Check.
- **Package installer.**
  - Interface: `add(name, range?)` and `install(packageJson)`. Both return the resolved versions and any warnings.
  - It reads the npm registry, picks the newest version that's at least a day old, and writes exact versions into `package.json`.
  - It resolves dependency ranges once per change to `package.json` and keeps the result out of sight in the Workspace's Durable Object. Exports carry no lockfile.
  - Each Package has one version. A version listed in `package.json` wins; otherwise the newest version every requester accepts is used. Conflicts and peer dependencies whose versions don't fit become warnings.
  - It keeps only `.js`, `.mjs`, `.cjs`, `.d.ts`, `.d.mts`, `.d.cts`, `.css` and `.json` files, and skips Packages built for a specific operating system or CPU.
  - Each Workspace keeps its own copies.
- **Builder.**
  - Input: a snapshot and its Packages. Output: either a Build (hash, modules, assets) with any warnings, or Build errors.
  - It wraps `@cloudflare/worker-bundler` unmodified. The bundler is loaded on the first Build inside the Workspace's Durable Object, and can move to a separate isolate behind the same interface if memory runs short.
  - It reads `wrangler.jsonc`.
  - It caches Builds by a hash of their inputs.
  - A Build fails if its output imports any package other than `cloudflare:*` and `node:*`.
  - For the Worker + React Template, it runs a Tailwind step using the platform's fixed Tailwind version, our own class-name scanner and no plugins (ADR 0007). The fallback is a plain CSS entry.
- **Workspace agent.**
  - **Model:** Opus 5.5 through the Anthropic API directly, set by a configuration variable, with prompt caching. A Turn has at most 40 steps.
  - **Tools:**
    - Think's file tools and its built-in bash;
    - `check`, `build` and `add_package`;
    - `request_preview` and `preview_logs`;
    - `test`.
  - **Turn lock:** enforced on the server, so file writes from the Developer are refused while a Turn runs.
  - **Before a Turn:** the next Turn is told which files the Developer changed, and the Workspace's `AGENTS.md` is added to the instructions on every Turn.
  - **End of a Turn:** a Check and then a Build run, sharing 3 retries. Tests then run and are shown, without retries.
  - **Start fresh:** compacts the Conversation.
  - **Limits:** the Durable Object's CPU limit is 5 minutes.
- **App host.**
  - It receives each new Build from the Workspace.
  - It loads the Preview (the latest good Build) and the Deployment (a published copy) into Dynamic Workers, keyed by Build hash.
  - It gives apps a Durable Object binding backed by facets, with Preview and Deployment data kept apart. Apps get no KV, D1, cron or queues (ADR 0006).
  - It collects server logs into a capped table, and collects front-end errors through a script it injects into HTML.
  - It runs apps with:
    - CPU and outgoing-request limits;
    - the compatibility date and flags from the app's `wrangler.jsonc`;
    - unrestricted outbound access;
    - per-Workspace secrets in `env`, whose names alone the Agent sees, and none of the platform's secrets.
- **Request gate.** It sits in the platform Worker in front of everything.
  - It verifies Access tokens for the platform's Access application and, separately, for the apps' Access application.
  - **Platform:** only people on the Installation's Developer list, of emails and `@domain` entries, may sign in. An empty list refuses everyone. It checks `Origin` on every API call and WebSocket upgrade.
  - **Apps:** a Preview is open only to its Developer, and a Deployment to anyone the apps' Access application lets in.
  - **Before app code runs:** it strips Access headers and the Access cookie.
  - **Cookies:** only `__Host-` cookies pass between the browser and app code, in both directions. Any other cookie an app sets is dropped, with a warning in its logs.
  - **Preview links:** it issues short-lived signed links for the Preview pane. The pane is a cross-site frame, which may not receive the apps' Access cookie (ADR 0012).
- **Developer directory.** One Durable Object per Developer, listing their Workspaces.
- **Test runner.**
  - A vitest-compatible runner built from `@vitest/runner`, `@vitest/expect`, `@vitest/spy` and `@sinonjs/fake-timers`.
  - Test files are built with the Workspace's code and run in a Dynamic Worker, which returns results over RPC.
  - It supports `describe`, `it`, `expect`, `vi.fn`, `vi.spyOn` and fake timers. It has no `vi.mock`, snapshots or coverage, and durations read about 0 ms.

### API between the single-page app and the platform

- The Conversation panel follows the Conversation over the Agents SDK's own WebSocket protocol for the Workspace agent. It starts Turns and Start fresh through the JSON API, so the platform runs each Turn's Check and retries itself.
- Everything else is a small JSON HTTP API:
  - Workspaces: list, create from a Template, delete;
  - Turns: start one, Start fresh;
  - files: tree, read, write;
  - problems;
  - zip export;
  - publish;
  - secret names;
  - Preview links.

### Templates (ADR 0005)

- **Worker:** a Hono app, `wrangler.jsonc` listing `nodejs_compat`, `tsconfig.json`, a generated `worker-configuration.d.ts`, `package.json` with exact versions and `"packageManager": "pnpm@…"`, and `AGENTS.md`.
- **Worker + React:** a Hono server entry, a React client entry with `jsx: "automatic"`, `index.html`, `public/` and a Tailwind stylesheet. `tailwindcss` isn't listed in `package.json`.
- **`AGENTS.md` rules:**
  - no CSS imports from code;
  - no CSS modules;
  - no `@/` aliases;
  - no image imports;
  - no `import.meta.env`;
  - cookie names start with `__Host-`.

### Hostnames

- A Deployment lives at `<slug>-<random>.<apps domain>`.
- Its Preview lives at `<slug>-<random>-preview.<apps domain>`.
- The apps domain is a registered domain of its own, set in the Installation's configuration (ADR 0012).

### Setup that the Operator does

- `wrangler login`.
- Both Access applications.
- The Anthropic API key as a Worker secret.
- The apps domain, with a proxied wildcard DNS record for `*.<apps domain>`. Universal SSL's certificate covers it. The platform's hostname itself is a Workers Custom Domain, which the platform's deploy creates with its DNS record and certificate.

The agent deploys everything else, including Worker routes.

## Testing Decisions

- **What a good test does:** it drives the platform the way a browser would, and asserts on what comes back. Tests never look at Durable Object tables, internal calls, or which library did the work, so swapping the bundler or the file store doesn't break them.
- **Seam 1, automated:** the platform Worker's HTTP and WebSocket interface. Tests run under vitest with `@cloudflare/vitest-plugin` on a laptop. Two stand-ins sit at the outer edge:
  - a scripted model in place of Anthropic, so Turns are repeatable;
  - recorded npm registry responses in place of npm.
- **Seam 2, measurement:** runs on the deployed Installation for memory, CPU, startup and timing, none of which can be measured locally. The results go into the findings document.
- **What Seam 1 covers:**
  - creating, listing, exporting and deleting Workspaces;
  - Check results for known-bad files;
  - installing Packages, version conflicts and the one-day minimum age;
  - Build success and failure, missing Packages, and Tailwind output;
  - the Turn lock and retries at the end of a Turn;
  - Preview and Deployment routing, Access checks, `Origin` checks, cookie filtering and header stripping;
  - keeping Preview and Deployment data apart;
  - test runner results.
- **No automated UI tests.** The single-page app is a thin client over Seam 1. Each stage's verdict includes a manual run-through in a browser.
- **Prior art:** the repo has no tests yet. worker-bundler's own end-to-end tests run its builds inside workerd, and are the pattern to copy.
- **Unknown:** whether Dynamic Workers and Durable Object facets run under the local vitest integration. The probe found that both do (ticket 02), so Preview and Deployment tests run locally through the same seam.

## Out of Scope

- Containers, the Sandbox SDK and Browser Rendering.
- Building or running Workspaces on a laptop. That includes Vite configs and exports meant for local work.
- Importing Workspaces.
- More than one Conversation per Workspace.
- Sharing Workspaces between Developers.
- Sign-in other than Cloudflare Access.
- A language service in the editor, and editor tabs.
- Cron triggers, queues, KV, D1 and R2 for apps.
- Rollback, and more than one Deployment per Workspace.
- A lockfile in exports.
- Nested Package versions.
- Tailwind plugins.
- `vi.mock`, snapshots, coverage, and component tests in a browser DOM.
- Workers for Platforms, AI Gateway and a shared Package cache.
- Restricting apps' outbound requests.
- Custom domains for apps.

## Further Notes

- **Main risks:**
  - Memory. ts-rust and esbuild don't fit in one isolate together (stage 1), so Checks run in a Dynamic Worker (ADR 0010). Builds share the Workspace's isolate with the Agent, which stays unmeasured until stage 3.
  - worker-bundler is experimental and fails silently in several ways.
  - ts-rust has a single maintainer, and no published module.
  - Tailwind's compiler API is internal.
  - Durable Object facets are new.
  - `@cloudflare/shell` is being retired in favour of `@cloudflare/computer`.
- **Background:** the research behind these decisions is in `docs/research/`, and the decisions that are hard to reverse are in `docs/adr/`.
- **Billing:** Dynamic Workers are billed per unique Worker ID and code per day, beyond 1,000 a month, and each new Build counts.
- **Cookie risk:** apps on the apps domain are the same site as each other (ADR 0012). One app's JavaScript can set a cookie for the whole apps domain, so the platform passes only `__Host-` cookies to and from app code.

Drafted by an AI agent on Jack's behalf.
