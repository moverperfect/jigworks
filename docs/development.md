# Development

What the scripts and config don't say: how to run the platform, check it live, and what was learned the hard way. CI (`.github/workflows/ci.yml`) runs the checks every pull request must pass. Run the same steps locally first.

## Running it

- **Generated files:** `pnpm generate` packs the Templates, the Checker's bundle, Tailwind's stylesheets, and the Tester's bundle and `vitest` types into `src/generated/`, which the typecheck, the tests and deploys need. Run it after changing `templates/`, `src/checker/worker.ts`, `src/tester/` or the Tailwind or vitest versions. Run `pnpm types` after editing `wrangler.jsonc`.
- **Locally:** `pnpm platform:dev` serves http://127.0.0.1:8787. `.dev.vars` (gitignored) needs `DEV_SIGNED_IN_AS` and `DEVELOPER_LIST`, both `developer@example.com`, and `PLATFORM_ORIGIN=http://127.0.0.1:8787`. The gate honours `DEV_SIGNED_IN_AS` only for localhost.
- **Turns without the real model:**
  1. Start the scripted model with `pnpm agent:fake`, which serves 127.0.0.1:8788.
  2. Add `AGENT_BASE_URL=http://127.0.0.1:8788/v1` and `ANTHROPIC_API_KEY=local-fake-key` to `.dev.vars`, and remove them afterwards.
  3. Start the Developer's first message with `[script:<name>]`. The scripts are in `test/fixtures/agent-scripts.ts`.
- **Stopping servers:** `wrangler` and `workerd` processes outlive the task that started them. From the repo root, `pkill -f "$PWD/node_modules/.*(wrangler|workerd)"`.
- **vitest stays on 4,** at 4.1.12, with `@cloudflare/vitest-plugin` 1.4.0 and `wrangler` 4.149.0:
  - Under vitest 5, plugin 1.4.0 fails everywhere.
  - Plugin 1.4.7 needs a miniflare beta. It passes locally, but crashes `builds.test.ts` and `files.test.ts` on GitHub's 2-core runner, even one file at a time.
  - Try again once the plugin's miniflare leaves beta. Keep `wrangler` on the plugin's version, so tests, dev and deploys share one workerd.
- **Overrides** (`pnpm.overrides` in `package.json`) lift two packages past exact pins in the test tools: miniflare pins `undici` 7.29.1, and plugin 1.4.0 pins `zod` 4.6.5. Both versions have security alerts (#27). An override applies only below the patched version, so it stops mattering once those tools pin patched versions themselves. Delete both then.

## Deploys

- **From `main`:** a push to `main` runs CI's checks, then `wrangler deploy` (`.github/workflows/ci.yml`). Deploys never overlap. Pushes that arrive during a deploy wait, and only the newest of them deploys.
  - **The token:** the `CLOUDFLARE_API_TOKEN` secret in the `production` environment, which only `main` may use, so only the deploy job can read it. It's made from the "Edit Cloudflare Workers" template. It's limited to Jack's account and the `jigworks.dev` and `jigworks.app` zones, with DNS edit so a deploy can create the platform's Custom Domain record.
  - **The account:** the `CLOUDFLARE_ACCOUNT_ID` secret, in the same environment, so it stays out of the logs.
- **Setting up an Installation:** `scripts/set-up-installation.sh` walks the Operator through everything only they can do, for the hostnames in `wrangler.jsonc`. It's safe to re-run. It keeps only public values, in `.wrangler/installation.env` (gitignored), and says which Access values `wrangler.jsonc` still needs. Secrets and the Developer list go straight to Cloudflare, Access or GitHub.
- **By hand,** if CI can't: `pnpm generate && pnpm --filter client build && npx wrangler deploy`.
- **`NOTICE.md`** lists the third-party code the Worker and the pages ship. After changing dependencies, rewrite it with `pnpm generate && pnpm --filter client build && node scripts/write-notice.mjs`. The client's build copies it into the pages as `/third-party-licences.md`.
- **The Developer list** is the `DEVELOPER_LIST` Worker secret, so the addresses stay out of the repo. Access lets people in first, so a change goes in two places:
  - the "Jigworks Developers" Access policy;
  - `npx wrangler secret put DEVELOPER_LIST`, with the whole list, because a secret can't be read back.

  Neither needs a deploy.
- **After changing `ANTHROPIC_API_KEY`,** rerun the deploy job on `main`, or deploy by hand as above. The Workspace's Durable Object reads it, and a Durable Object that's running keeps the version it started on, old secrets and all, until it restarts. On 2026-10-30, a Workspace kept a replaced key for nearly five minutes, until the redeploy fixed it at once. The Developer list is read by the platform Worker, which takes the new version straight away.

## Live checks

- **Capture:** run `npx wrangler tail jigworks --format json > .wrangler/tail.jsonl` in the background, and summarise it with `python3 -I scripts/tail-events.py .wrangler/tail.jsonl`.
  - The tail drops its connection on every deploy, reconnects, and writes a warning into the file. The script skips those lines.
  - Stopping the task leaves the tail running. Kill it with `pkill -f "[w]rangler.* tail jigworks"`; the brackets stop the pattern matching the shell that runs it.
- **Access and Previews** (ADR 0013): `curl -sI https://anything-preview.jigworks.app/` must reach the platform, with no redirect to `cloudflareaccess.com`, and `curl -sI https://anything.jigworks.app/` must still redirect to Access. Cloudflare doesn't document which of the two Access applications wins, so check both after each deploy.
- **The deployed clock:** `Date.now()` doesn't move during CPU work, during a call into a Dynamic Worker, or after a timer. Time from the platform Worker, whose call to the Durable Object is I/O, or use the trace's CPU and wall time.
- **Durable Object traces:**
  - A Durable Object's events are reported only when its invocation ends.
  - The last event in a burst shows wall time running on until the object's next event.
  - Work that a Turn runs after an awaited self-call is counted in that call's trace.
- **Workers Logs:** the API refuses wrangler's OAuth token (403), so use the tail.
- **Browser (T3 preview tools):**
  - `preview_evaluate` gives up after about 15 s, so poll long waits in steps.
  - `preview_type` times out on the Workspace page, so use `preview_evaluate`: `document.execCommand('insertText', ...)` in the textarea, then click "Send". `preview_snapshot` used to time out there too, but it worked for #44's live check on 2026-10-30.
  - Access sign-in expires overnight. Ask Jack to sign in, rather than signing in yourself.

## Learned the hard way

Most of these are in code comments and ADRs too. Recheck them first when upgrading Think, the Agents SDK, the AI SDK, worker-bundler or Tailwind.

- **Think 0.20.2:** `onChatResponse` can't start another turn, so `runDeveloperTurn` drives Turns with `saveMessages` from an alarm (ADR 0011). The Workspace relies on Think and Agents SDK behaviour that a version bump could change:
  - **The socket only watches:** `webSocketMessage` is overridden to drop client frames, then hands the rest to `this.lifecycle.webSocketMessage`. The SDK installs its own handler only if the class has none.
  - **No recovery:** `onChatRecovery` returns `{ continue: false }`, so a restart ends a Turn.
  - **Late connections:** `onConnect` sends the history to a socket that connects mid-Turn.
  - **Hooks:** override them as methods, not arrow-function fields, and give them names Think doesn't own. Think owns `queue`, `runTurn`, `session`, `messages` and `state`.
  - **Tests:** `test/conversation.test.ts` covers each of these.
- **Anthropic:**
  - `@ai-sdk/anthropic` is pinned to 4.0.79, the version Think uses.
  - The provider reads `ANTHROPIC_BASE_URL` itself and throws when it's empty, so ours is `AGENT_BASE_URL`.
  - The Messages API needs the first message to be the user's, so Start fresh keeps the first message.
  - The settings are in `src/agent/index.ts`: effort `high`, `fallbacks: "default"`, `drop_block` for mismatched thinking blocks, and automatic caching.
- **Parallel tool calls:** Opus calls `edit`, `bash`, `check` and `build` in the same step. `check` and `build` wait for their siblings, counted with `beforeToolCall` and `afterToolCall`.
- **Agents SDK upgrades:** `agents` pins its MCP SDK peers (`@modelcontextprotocol/sdk`, `client` and `server`) to exact versions. pnpm keeps the peers it has already installed, so after bumping `agents`, check that `pnpm install` reports no "unmet peer". If it does, add the pinned versions as direct dependencies, install, and then remove them; the lockfile keeps the new versions.
- **App data (ADR 0015):** an app's Durable Object instances are facets in its app host. The platform relies on facet behaviour that a workerd upgrade could change, and `test/app-data.test.ts` covers each:
  - `ctx.facets.abort()` makes the next call start the facet with new code, its storage kept;
  - `deleteAll()` doesn't reach a facet's database (locally, the deletion test fails without the loop), so the app host deletes each facet it started by name;
  - nothing documents alarms in a facet, so apps aren't told they can use them.
- **worker-bundler:** it runs its own npm installer for any Package missing from `node_modules/`, which would skip the one-day rule. The Builder strips `dependencies` before handing over `package.json`.
- **Tailwind** (ADRs 0007 and 0014): the platform has one version, `tailwindcss` in its own `package.json`. To upgrade, change that exact version and run `pnpm generate`, which packs its stylesheets. The version goes into every Build's hash, so each Workspace's next Build uses it.
- **The Tester's vitest** (ADR 0017) is `@vitest/runner`, `@vitest/expect`, `@vitest/spy` and `@vitest/utils` at the platform's own vitest version, with `@sinonjs/fake-timers`. Upgrade them together with vitest, run `pnpm generate`, and run `test/tests.test.ts`. Recheck `src/tester/runtime.ts` against vitest's own `createExpect`, `TestRunner` and `FakeTimers` in `vitest/dist/chunks/`, which it copies in part, and `src/tester/types/vitest.d.ts` against vitest's `vi`.
- **Size:** with Tailwind, the Worker + React Template and the Tester, the Worker is 8,075 KiB compressed (`npx wrangler deploy --dry-run`), against Cloudflare's 10 MiB limit. The Tester and its `vitest` types took 134 KiB of that. The Templates' runtime types, 623 KB, are packed once for all of them.
