# Handover

This file covers what isn't already in the repo: where the work stands, how Jack wants it done, and what was learned the hard way. The decisions and their history are in the places listed below. Read them first.

## Where things stand

- **The product:** Jigworks. On 2026-10-23 a grilling session turned the experiment into a product. Its decisions are recorded in tickets 14 to 22. In short:
  - first, Installations that an organisation runs on its own Cloudflare account, behind its own Access;
  - later, a hosted SaaS built from the same repository (ticket 22);
  - the licence is PolyForm Noncommercial plus PolyForm Free Trial, with commercial licences sold to companies;
  - the repo becomes the public `moverperfect/jigworks` in ticket 18.
- **Tickets:** 01–07 are resolved. The order now is 14, 15, 16, 17, 18, then 08 to 13, then 19 to 22. Each resolved ticket ends with dated comments covering what was built, the review findings fixed and not fixed, and the live check.
- **Verdicts** (`docs/findings.md`):
  - stage 1, yes with a caveat;
  - stages 2 and 3, yes;
  - stage 4: Builds are measured and fit; the verdict waits for the Preview.
- **Code:**
  - The repo arrived on this Linux machine without its git history. The last commit on the old machine was `ae7a5a0`.
  - Locally, a `baseline` commit holds the files as they arrived, so that tickets 14 and 15 can be reviewed as a diff. It's never pushed. Ticket 16 starts the history afresh on `main`.
- **Deployed:** nothing on Jack's account yet (ticket 17). An earlier copy of the platform runs on another account. Don't touch it; Jack takes it down.
- **Spend:** about $1 of Anthropic usage so far (Opus 5.5, prompt-cached).

**Where to read:**
- `.scratch/jigworks/spec.md` and `issues/` (GitHub Issues from ticket 16);
- `GLOSSARY.md`;
- `docs/adr/` (0010 Checks in a Dynamic Worker; 0011 the platform runs each Turn);
- `docs/findings.md`;
- `docs/research/`.

## How Jack wants the work done

- **One ticket at a time, in order.** Use subagents for parallel or bulky work. A UI subagent did most of `client/`, briefed with the server contract and asked for a browser check against `wrangler dev`.
- **Before a ticket's work is committed, or its pull request is ready:**
  1. Run the `code-review` skill for Standards and Spec. Add a third subagent for Lean: what could be removed or simplified.
  2. Get Codex's second opinion, as a tracked background task; it takes about 10 minutes:
     - uncommitted work: `codex exec --skip-git-repo-check -o .wrangler/codex-NN.md review --uncommitted < /dev/null`;
     - a branch: `codex exec -o .wrangler/codex-NN.md review --base main < /dev/null`.
  3. Check every finding against the code, fix the real ones, and give each fix a test that fails without it. Run Codex again after large fixes.
  4. In the ticket's comment, list what was fixed and what wasn't changed, with the reason.
- **Branches, from ticket 16:**
  - each ticket gets a branch and a pull request that closes its issue;
  - commit to the branch as you go;
  - a pull request merges only when Jack says so.
- **Deploys, from ticket 17:**
  - every merge to `main` deploys once the tests pass, with no go-ahead needed;
  - after a deploy, do a live check from Jack's signed-in browser, put the measurements in `docs/findings.md`, add a dated comment to the ticket, and mark it resolved.
- **Before live model runs,** state a usage budget.
- **Words:** use the glossary's words in code, UI text and docs (Conversation, never "chat"; Turn, Check, Build, Package, Developer, Agent, Installation, Operator), in British English.
- **Organisation-neutral:** nothing in the repo, its commits, issues or pull requests names a particular organisation, its hostnames or its people's work addresses. Values specific to one Installation live in its configuration. Docs may use Jack's Installation (`app.jigworks.dev`, `jigworks.app`) as the example.
- **No Claude Code memory:** Jack has turned it off. Durable notes go in this file.

## Commands

- **Install:** `pnpm install` (pnpm 9.15.4, Node 24). Dependencies are exact versions published at least a day ago.
- **Check the code:**
  - `pnpm typecheck`, and `pnpm --filter client typecheck` and `build`;
  - `pnpm test` runs 134 tests in about 40 s on Linux;
  - stay on vitest 4.1.11 for now, because `@cloudflare/vitest-plugin` broke under vitest 5 on Windows. Ticket 16 tries vitest 5 on Linux.
- **After changing config or generated inputs:**
  - `pnpm generate` repacks the Templates and the Checker's bundle. Run it after changing `templates/` or `src/checker/worker.ts`, and before deploying.
  - `pnpm types` after editing `wrangler.jsonc`.
- **Deploy:** `pnpm generate && pnpm --filter client build && npx wrangler deploy`. From ticket 17, CI does this on every merge to `main`.
- **Run locally:** `pnpm platform:dev` serves http://127.0.0.1:8787. `.dev.vars` (gitignored) holds `DEV_SIGNED_IN_AS` and `DEVELOPER_LIST`, both `developer@example.com`, and `PLATFORM_ORIGIN=http://127.0.0.1:8787`.
- **Turns without the real model:**
  1. Start the scripted model with `pnpm agent:fake`, which serves 127.0.0.1:8788.
  2. Add `AGENT_BASE_URL=http://127.0.0.1:8788/v1` and `ANTHROPIC_API_KEY=local-fake-key` to `.dev.vars`, and remove them afterwards.
  3. Start the Developer's first message with `[script:<name>]`. The scripts are in `test/fixtures/agent-scripts.ts`.
- **Stopping servers:** `wrangler` and `workerd` processes outlive the task that started them. Stop them by command line, from the repo root:

  ```sh
  pkill -f "$PWD/node_modules/.*(wrangler|workerd)"
  ```

## Live checks

- **Capture:** run `npx wrangler tail jigworks --format json > .wrangler/tail.jsonl` in the background. Summarise it with `python3 -I scripts/tail-events.py .wrangler/tail.jsonl`.
  - The tail drops its connection on every deploy, reconnects, and writes a warning into the file; the script skips those lines.
  - Stopping the task leaves the tail running. Kill it with `pkill -f "[w]rangler.* tail jigworks"`. The brackets stop the pattern matching the shell that runs it.
- **The deployed clock:** `Date.now()` doesn't move during CPU work, a call into a Dynamic Worker, or after a timer. Time from the platform Worker, whose call to the Durable Object is I/O, or use the trace's CPU and wall time.
- **Durable Object traces:**
  - A Durable Object's events are reported only when its invocation ends.
  - The last event in a burst shows wall time running on until the object's next event.
  - Work that a Turn runs after an awaited self-call is counted in that call's trace.
- **Workers Logs:** the API refuses wrangler's OAuth token (403). Use the tail.
- **Browser (T3 preview tools):**
  - `preview_evaluate` gives up after about 15 s, so poll long waits in steps.
  - `preview_snapshot` and `preview_type` time out on the Workspace page. Use `preview_evaluate` instead: `document.execCommand('insertText', ...)` in the textarea, then click "Send".
  - Access sign-in expires overnight. Ask Jack to sign in rather than doing it yourself.

## Learned the hard way

Most of these are in code comments and ADRs too. They're the first things to recheck when upgrading Think, the Agents SDK, the AI SDK or worker-bundler.

- **Think 0.20.2:** `onChatResponse` can't start another turn, so `runDeveloperTurn` drives Turns with `saveMessages` from an alarm (ADR 0011). The Workspace relies on Think and Agents SDK behaviour that a version bump could change:
  - **The socket only watches:** `webSocketMessage` is overridden to drop client frames, then hands the rest to `this.lifecycle.webSocketMessage`. The SDK installs its own handler only if the class has none.
  - **No recovery:** `onChatRecovery` returns `{ continue: false }`, so a restart ends a Turn.
  - **Late connections:** `onConnect` sends the history to a socket that connects mid-Turn.
  - **Hooks:** override them as methods, never as arrow-function fields, and don't use names Think owns (`queue`, `runTurn`, `session`, `messages`, `state`).
  - **Tests:** `test/conversation.test.ts` covers each of these.
- **Anthropic:**
  - `@ai-sdk/anthropic` is pinned to 4.0.79, the version Think uses.
  - Don't name an environment variable `ANTHROPIC_BASE_URL`: the provider reads it itself and throws when it's empty. Ours is `AGENT_BASE_URL`.
  - The Messages API needs the first message to be the user's, so Start fresh keeps the first message.
  - The settings are in `src/agent/index.ts`: effort `high`, `fallbacks: "default"`, `drop_block` for mismatched thinking blocks, and automatic caching.
- **Parallel tool calls:** Opus calls `edit`, `bash`, `check` and `build` in the same step. `check` and `build` wait for their siblings, counted with `beforeToolCall` and `afterToolCall`.
- **worker-bundler:** it runs its own npm installer for any dependency missing from `node_modules/`. The Builder strips `dependencies` before handing over `package.json`.
- **Size:** the Worker is 7.8 MB compressed against Cloudflare's 10 MB limit. Tickets 09 (Tailwind) and 13 (test runner) have about 2.2 MB between them.

## Next

- **Tickets 14 to 18** move the platform to Jack's own name, account and public repo. Ticket 17's wizard covers what Jack must set up: the domains, Access, DNS, secrets and the deploy token.
- **Follow-ups from 07 that 08 should pick up:**
  - Move the Build after a save to the server, because the Preview must follow every save even when the page closes.
  - Builds are cached only in memory, 4 per isolate; the app host keeps them durably (ADR 0009).
- **Other open items, recorded in the tickets:**
  - The Agent can't read Package files (06).
  - The Conversation socket retries forever after the sign-in expires (06).
  - The Workspace page's bundle is 935 kB, with 52 kB of capnweb the SDK imports (06).
  - esbuild's memory grows with each Build (findings, stage 4).
  - Bare Node built-in names pass the missing-import check whatever the compatibility flags (07).
