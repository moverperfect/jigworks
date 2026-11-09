# Development

What the scripts and config don't say: how to run the platform, check it live, and what was learned the hard way. CI (`.github/workflows/ci.yml`) runs the checks every pull request must pass. Run the same steps locally first.

## Running it

- **Generated files:** `pnpm generate` packs the Templates and add-ons, the Checker's bundle, Tailwind's stylesheets, and the Builder's, the Tester's and the Test bundler's bundles and `vitest` types into `src/generated/`, which the typecheck, the tests and deploys need. Run it after changing `templates/`, `addons/`, `src/templates/pack.ts`, `src/checker/worker.ts`, `src/tester/` or `src/builder/`, or the Tailwind or vitest versions. Run `pnpm types` after editing `wrangler.jsonc`. `templates/pack.mjs` imports `src/templates/pack.ts` as it is, so it needs a Node that strips types itself (23.6 or later; `.node-version` has 24).
- **Locally:** `pnpm platform:dev` serves http://127.0.0.1:8787. `.dev.vars` (gitignored) needs `DEV_SIGNED_IN_AS` and `DEVELOPER_LIST`, both `developer@example.com`, and `PLATFORM_ORIGIN=http://127.0.0.1:8787`. The gate honours `DEV_SIGNED_IN_AS` only for localhost.
- **Turns without the real model:**
  1. Start the scripted model with `pnpm agent:fake`, which serves 127.0.0.1:8788.
  2. Add `AGENT_BASE_URL=http://127.0.0.1:8788/v1` and `ANTHROPIC_API_KEY=local-fake-key` to `.dev.vars`, and remove them afterwards.
  3. Start the Developer's first message with `[script:<name>]`. The scripts are in `test/fixtures/agent-scripts.ts`.
- **Stopping servers:** `wrangler` and `workerd` processes outlive the task that started them. From the repo root, `pkill -f "$PWD/node_modules/.*(wrangler|workerd)"`. That also stops a live check's `wrangler tail` from the same checkout, so during a live check use `pkill -f "$PWD/node_modules/.*(wrangler dev|workerd)"`.
- **vitest stays on 4,** at 4.1.12, with `@cloudflare/vitest-plugin` 1.4.0 and `wrangler` 4.149.0:
  - Under vitest 5, plugin 1.4.0 fails everywhere.
  - Plugin 1.4.7 needs a miniflare beta. It passes locally, but crashes `builds.test.ts` and `files.test.ts` on GitHub's 2-core runner, even one file at a time.
  - Try again once the plugin's miniflare leaves beta. Keep `wrangler` on the plugin's version, so tests, dev and deploys share one workerd.
- **The vitest plugin's patch** (`patches/`, in `pnpm.patchedDependencies`) gives 1.4.0 the plugin's own fix from 1.4.11 (cloudflare/workers-sdk#15565). Without it, a run sometimes hung after its last test file had passed (#106). The plugin holds back a `console.log` made in a Durable Object's own context, such as the `build` line of a Build that a save scheduled, until the runner's next message. vitest waits for every log's reply before it ends a file, so a log held back after the file's last result is never sent. On upgrading the plugin, delete the patch and its entry: `pnpm install` refuses a patch it can't apply (`ERR_PNPM_PATCH_NOT_APPLIED`).
- **CI's test step** stops after 6 minutes, about three times its usual 2, so a hang fails in minutes and can be rerun, rather than holding the runner for the job's 20.
- **Overrides** (`pnpm.overrides` in `package.json`) lift two packages past exact pins in the test tools: miniflare pins `undici` 7.29.1, and plugin 1.4.0 pins `zod` 4.6.5. Both versions have security alerts (#27). An override applies only below the patched version, so it stops mattering once those tools pin patched versions themselves. Delete both then.

## Deploys

- **From `main`:** a push to `main` runs CI's checks, then `wrangler deploy` (`.github/workflows/ci.yml`). Deploys never overlap. Pushes that arrive during a deploy wait, and only the newest of them deploys.
  - **The token:** the `CLOUDFLARE_API_TOKEN` secret in the `production` environment, which only `main` may use, so only the deploy job can read it. It's made from the "Edit Cloudflare Workers" template, whose Workers R2 Storage permission lets a deploy bind the Package cache. It's limited to Jack's account and the `jigworks.dev` and `jigworks.app` zones, with DNS edit so a deploy can create the platform's Custom Domain record.
  - **The account:** the `CLOUDFLARE_ACCOUNT_ID` secret, in the same environment, so it stays out of the logs.
- **Setting up an Installation:** `scripts/set-up-installation.sh` walks the Operator through everything only they can do, for the hostnames in `wrangler.jsonc`. It's safe to re-run. It keeps only public values, in `.wrangler/installation.env` (gitignored), and says which Access values `wrangler.jsonc` still needs. Secrets and the Developer list go straight to Cloudflare, Access or GitHub.
- **The Package cache** (ADR 0020) is the R2 bucket `PACKAGE_CACHE` names in `wrangler.jsonc`: `jigworks-package-cache` on Jack's account, created on 2026-11-09. A deploy looks for it through the R2 API and creates it if it's missing (wrangler's provisioning), so a token without R2 permission fails the deploy there. The wizard creates it for a new Installation before the first deploy. Nothing in it is ever deleted; emptying it only costs Workspaces their next download from npm. Each install logs an `install` line in the tail: tarballs taken from the cache, the time resolving and fetching, and the Workspace's database size.
- **Who can open Deployments** is the Operator's choice, made in the "Jigworks apps" Access application. `DEPLOYMENTS_OPEN_TO_EVERYONE` in `wrangler.jsonc` records it, so that the page says who can use a published app: anyone with the link, or only people on this Jigworks's list. Leave it `false` unless that application lets everyone in.
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
  - **No recovery:** `onChatRecovery` returns `{ continue: false }`, so a restart ends a Turn. `onStart` runs inside `blockConcurrencyWhile`, so the Turn's Check and Build, which undo it if the app is broken (ADR 0018), run afterwards in an alarm: a Build calls the object back, which would wait for `onStart` forever.
  - **Late connections:** `onConnect` sends the history to a socket that connects mid-Turn.
  - **Hooks:** override them as methods, not arrow-function fields, and give them names Think doesn't own. Think owns `queue`, `runTurn`, `session`, `messages` and `state`.
  - **Tests:** `test/conversation.test.ts` covers each of these.
- **Anthropic:**
  - `@ai-sdk/anthropic` is pinned to 4.0.79, the version Think uses.
  - The provider reads `ANTHROPIC_BASE_URL` itself and throws when it's empty, so ours is `AGENT_BASE_URL`.
  - The Messages API needs the first message to be the user's, so Start fresh keeps the first message.
  - The settings are in `src/agent/index.ts`: effort `high`, `fallbacks: "default"`, `drop_block` for mismatched thinking blocks, and automatic caching.
- **Undoing a Turn** copies and restores the rows of the file store's own table, `cf_workspace_default` (`src/files/index.ts`), in one transaction, so a restart can't leave the files half put back. The copy takes the table's columns as they are when the Turn starts, so an upgrade of Think or `@cloudflare/shell` that changes them would fail to undo a Turn that was running across the deploy. After upgrading either, check the table, and run `test/files.test.ts`.
- **Parallel tool calls:** Opus calls `edit`, `bash`, `check` and `build` in the same step. Think starts each call in the order the model gave them, and the hooks in `src/workspace/index.ts` order them. The tools that change files (`write`, `edit`, `delete`, `bash`, `add_package` and `add_addon`) run one at a time, each waiting in `beforeToolCall` for the one before it to reach `afterToolCall`: two `edit`s to one file lost a change when they ran together (#103), and `bash` copies the files when it starts and writes them back when its script ends. The reading tools don't wait, so a `read` given after an `edit` in the same step may see the file from before it. `check`, `build` and `test` wait for all their siblings. A tool that changes files waits however long the one before it takes, since the step can't end before its tools anyway. In case one never reports back, `check`, `build` and `test` stop waiting after a minute in which none of their siblings has finished.
- **Agents SDK upgrades:** `agents` pins its MCP SDK peers (`@modelcontextprotocol/sdk`, `client` and `server`) to exact versions. pnpm keeps the peers it has already installed, so after bumping `agents`, check that `pnpm install` reports no "unmet peer". If it does, add the pinned versions as direct dependencies, install, and then remove them; the lockfile keeps the new versions.
- **App data (ADR 0015):** an app's Durable Object instances are facets in its app host. The platform relies on facet behaviour that a workerd upgrade could change, and `test/app-data.test.ts` covers each:
  - `ctx.facets.abort()` makes the next call start the facet with new code, its storage kept;
  - `deleteAll()` doesn't reach a facet's database (locally, the deletion test fails without the loop), so the app host deletes each facet it started by name;
  - nothing documents alarms in a facet, so apps aren't told they can use them.
- **worker-bundler:** it runs its own npm installer for any Package missing from `node_modules/`, which would skip the one-day rule. The Builder strips `dependencies` before handing over `package.json`. Its resolver also counts `node` among a Package's export conditions, which took React's Node build of `react-dom/server` into the tests' bundle (stage 6), so the Packages' `node` conditions are stripped too (`src/builder/bundling.ts`). The Builder and the Test bundler import esbuild's module from its `dist/esbuild.wasm` by path; check it's still there. Packing them also starts esbuild's Go runtime with `GOGC=25`, by patching the line that gives it an empty environment (`scripts/pack-tester.mjs`, #99). `pnpm generate` fails if a new esbuild changes that line; find its new form in the packed bundle and patch that.
- **Hono in the platform's tests** is the real one, from the platform's own `node_modules`, cut down to the files that `hono`, `hono/cookie` and `hono/html` import (`test/fixtures/real-package.mjs`), so the Templates and add-ons run as a Developer's app would. An add-on that imports another part of Hono adds that entry in `vitest.config.ts`. The fake registry's other Packages are made up (`test/fixtures/registry-data.ts`).
- **Resend in the platform's tests** is a fake (`test/fixtures/fake-resend.ts`) that copies how Resend's test sender refuses an address other than the account's own. If Resend changes that, change the fake, the email add-on's notes and its tests together. The page's note beside the app says what the email add-on's errors mean from their words (`client/src/appArea.ts`, tested in `test/app-area.test.ts` on the add-on's own output), so rewording an error means checking that too.
- **Anthropic in the platform's tests** is one fake (`test/fixtures/fake-anthropic.ts`) for the platform's scripted model and for apps with the AI add-on, which call the same API: an app's request has no tools, so it gets the summary reply, and the fake knows only the platform's test key. It takes the key as `Authorization: Bearer` (the AI add-on) or `x-api-key` (the platform's AI SDK), and the versions `2023-06-01` (the AI SDK) and `2026-10-21` (the add-on). If Anthropic changes how it takes keys or versions, change the fake, the AI add-on and its tests together. As for email, the page's note reads the AI add-on's errors.
- **No fake timers in the platform's tests:** its Durable Objects run in the test file's isolate, so a timer they set while `vi.useFakeTimers()` is on never fires, and a whole run can hang. Pass a short deadline in instead.
- **Platform method names:** `test` is one of a Worker's handler names, so a Durable Object method called `test` can't be called over RPC in tests ("The RPC receiver does not implement the method"). Hence `runTests`.
- **Tailwind** (ADRs 0007 and 0014): the platform has one version, `tailwindcss` in its own `package.json`. To upgrade, change that exact version and run `pnpm generate`, which packs its stylesheets. The version goes into every Build's hash, so each Workspace's next Build uses it.
- **The Tester's vitest** (ADR 0017) is `@vitest/runner`, `@vitest/expect`, `@vitest/spy` and `@vitest/utils` at the platform's own vitest version, with `@sinonjs/fake-timers`. Upgrade them together with vitest, run `pnpm generate`, and run `test/tests.test.ts`. Recheck `src/tester/runtime.ts` against vitest's own `createExpect`, `TestRunner` and `FakeTimers` in `vitest/dist/chunks/`, which it copies in part, and `src/tester/types/vitest.d.ts` against vitest's `vi`.
- **Size:** with Tailwind, the Worker + React Template and the Tester, the Worker was 8,198 KiB compressed; with the storage add-on, 8,205 KiB; with the organiser's area, 8,213 KiB; with Builds in the Builder (#87), 8,151 KiB; with sending email, 8,156 KiB; with calling an AI model, 8,159 KiB (`npx wrangler deploy --dry-run`, which needs a `client/dist` folder, even an empty one), against Cloudflare's 10 MiB limit. The Builder's bundle is 808 kB, and moved worker-bundler and Tailwind's compiler out of the Worker's own code. The Tester, the Test bundler and the `vitest` types took 257 KiB of the Worker. The Test bundler passes on the platform's own copy of esbuild's module: wrangler names modules by their content's hash, so it's carried once. The Templates' runtime types, 623 KB, are packed once for all of them.
