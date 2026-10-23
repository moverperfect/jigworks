# 06: Chat with the Agent in Turns

**Parent:** [spec](../spec.md), user stories 10, 22, 29 to 38 and 40 (stage 3)

**What to build:** The Developer sends a message in the Conversation panel and watches the Agent's Turn as it happens. During the Turn the Agent can:
- read and change files;
- use bash;
- ask for a Check;
- add Packages.

The editor is locked while the Turn runs. The Turn ends with a Check. If the Check has errors, the Agent gets up to 3 more tries to fix them. The Conversation is still there when the Developer comes back.

**Blocked by:** 05 (Edit files with live Checks).

**Status:** resolved

- [x] The Conversation panel on the Workspace page streams each Turn as it happens.
- [x] The Conversation's WebSocket route goes through the request gate (Access token, Developer allowlist, `Origin` and `Sec-Fetch-Site`), as `/api/*` does since ticket 03.
- [x] The Agent uses Opus 5.5 through the Anthropic API directly, set by a configuration variable. The key is a Worker secret Jack sets. Prompt caching is on, and a Turn has at most 40 steps.
- [x] The Agent has these tools:
  - Think's file tools and built-in bash;
  - `check`, which returns the current errors;
  - `add_package`, which uses 04's operation and returns any warnings.
- [x] While a Turn runs, the server refuses the Developer's file writes, and the editor shows as locked.
- [x] Each Turn is told which files the Developer changed since the last one.
- [x] The Workspace's `AGENTS.md` is in the Agent's instructions on every Turn.
- [x] Every Turn ends with a Check. If the Check shows errors, the Agent gets up to 3 more tries.
- [x] The Conversation is kept across visits. Start fresh compacts it.
- [x] Tests drive Turns with a scripted model through the platform's WebSocket interface.
- [x] The findings document gets the stage 3 verdict: whether the Agent reaches a clean Check within a Turn, and how long that takes.

## Tasks

1. Think agent with the model setting, prompt caching and the 40-step cap. Jack sets the Anthropic key.
2. Tools: file tools, bash, `check` and `add_package`.
3. Turn lock and the note of files the Developer changed.
4. Add `AGENTS.md` to the Agent's instructions.
5. A Check at the end of each Turn, with 3 retries.
6. Conversation panel, with Start fresh.
7. Scripted model for tests.
8. Write the stage 3 verdict.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-22, agent:** Built, reviewed and checked locally with a scripted model. Not deployed. The stage 3 verdict needs Turns with the real model, after Jack sets `ANTHROPIC_API_KEY`.

- **How a Turn runs** ([ADR 0011](../../../docs/adr/0011-the-platform-runs-each-turn.md)):
  - The page starts a Turn with `POST /api/workspaces/:id/turns`, and the Workspace runs it in `runDeveloperTurn`: the Developer's message, a Check, then up to 3 retries while the Check has errors.
  - The Conversation socket at `/api/workspaces/:id/conversation` only watches. The Workspace drops every frame a socket sends except the stream-resume handshake, so a socket can't start a Turn, clear the Conversation or unlock the editor.
  - This changes the spec's API section, which said the panel "uses the Agents SDK's own WebSocket protocol". Think can't start the retry turns from its own end-of-turn hook.
- **Turn lock:** the Workspace's state holds the running Turn, which the SDK broadcasts to every socket.
  - While a Turn runs, the Developer's saves, Package adds, other Turns and Start fresh get 409.
  - Starting a Turn waits behind Package work already queued, so a save or an add that arrived first lands before the lock, and the Turn is told about it.
- **Model** (`src/agent/index.ts`):
  - `AGENT_MODEL` (`claude-opus-5-5`) on the Anthropic API with `@ai-sdk/anthropic` 4.0.79, the version Think already uses.
  - Anthropic's automatic prompt caching and `effort: "high"`. Opus 5.5 defaults to `medium`.
  - `fallbacks: "default"`, so a Turn a safety classifier declines is retried on Anthropic's recommended model.
  - Thinking blocks that no longer match the history are dropped, not refused.
  - Think's read-time truncation is off (`truncationStep = Infinity`) to keep the cached prefix stable.
- **Steps:** 40 per Turn, shared by its retries. A Turn that used them all says so, and gets no more retries.
- **Instructions:** our standing instructions, then the Workspace's `AGENTS.md` as it is when each Think turn starts. The note of files the Developer changed is saved as a second part of their message, not added per request, so the history stays append-only.
- **Tools:** Think's `read`, `write`, `edit`, `list`, `find`, `grep`, `delete` and `bash`, plus `check` and `add_package`. A failed add throws, so the Conversation shows it as failed.
- **Start fresh:** folds everything after the Developer's first message into a model-written summary. The first message stays because the Messages API needs a Conversation to start with a user message.
- **Restarts:** a Turn can't outlive the isolate running it. Think keeps a cut-off reply but doesn't carry it on, and the new isolate records the Turn as stopped.
- **A page opened mid-Turn:** Think sends no history while a reply streams, so the Workspace sends it as the socket connects.
- **Logs:**
  - **Turns:** each Turn logs `{event: "turn", workspace, durationMs, status, error, checkErrors, retries, outOfSteps, steps, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`. `durationMs` may leave out the last Check, because the clock moves only at I/O.
  - **Checks:** every Check logs `{event: "check", workspace, by, counts, packages}`, where `by` is `developer`, `turn` or `agent`. The Workspace can't time a Check. Live, waiting on a 1 ms timer first gave 4–10 ms against 340 ms measured outside, so a timer doesn't move the clock either.
  - **The platform Worker** logs `check-request` with the time a Developer's Check took.
- **Page** (`client/src`):
  - `ConversationPanel.tsx` and `useConversation.ts`, using `agents/react` and `@cloudflare/think/react`, with `@ai-sdk/react` 4.0.141 added.
  - A status line shows the elapsed time and how the last Turn ended.
  - Send is disabled while the open file has unsaved changes.
  - While a Turn runs, the editor is read-only and Save is off.
  - Afterwards the file tree, the open file and the problems list reload.
  - The Workspace page's bundle grew from 628 kB to 934 kB (302 kB gzipped), mostly the SDK's dependencies.
- **Tests:** 14 in `test/conversation.test.ts`, through the socket and the API. The model is a fake Anthropic Messages API in the miniflare outbound service (`test/fixtures/fake-anthropic.ts`), playing scripts (`test/fixtures/agent-scripts.ts`) named in the Developer's first message. 118 tests in all.
- **Local runs:** `pnpm agent:fake` serves the same scripts on 127.0.0.1:8788 for `wrangler dev`, with `AGENT_BASE_URL=http://127.0.0.1:8788/v1` in `.dev.vars`.
- **Reviewed:** by three Claude reviewers (standards, spec, lean) and Codex as a second opinion. Codex reviewed again after the fixes.
  - **Fixed:**
    - the socket accepted chat requests, clears and state changes, which bypassed the lock and the Check;
    - Think's recovery could carry a Turn on with no lock or Check;
    - a queued save or Package add could land during a Turn (every Developer save now waits in line with Turns starting);
    - Checks inside a Turn weren't logged;
    - a Turn whose model call threw skipped its Check;
    - the page could show a pre-Turn report as current when the Turn's Check didn't run;
    - a page opened mid-Turn showed no history;
    - a failed `add_package` looked like a success;
    - the step limit was invisible;
    - renames and Lean cuts.
  - **Not changed:**
    - the elapsed-time display and the Start fresh dialog, which matches the delete dialog;
    - capnweb, which `agents/react` imports statically, at 52 kB;
    - an expired sign-in makes the socket retry forever.

**2026-10-22, agent:** Deployed and checked live with Opus 5.5. The stage 3 verdict is in `docs/findings.md`: yes. Seven Turns all ended with a clean Check, one after a retry. They took 6–41 s and cost $0.03–0.11 each, about $0.50 in all.

- **Fixed during the live run** (each deployed with Jack's go-ahead for this check):
  - `b90867e`: a Turn run in the background of `startTurn` kept that invocation open, so its logs never reached Workers Logs. Turns now run in an alarm of their own. An alarm handler can run for at most 15 minutes, which caps a Turn's length.
  - `d442e9b`: the `check` tool raced edits the model called in the same step, so it could report the files as they were before the edit. It now yields to the event loop first.
- **Follow-up:** the Agent can't read Package files such as Hono's type declarations, because Packages aren't in Think's file store. Read-only access to them would help it use Packages correctly.
- **Workspaces left on the platform:** "Stage 3 Agent" and "Stage 3 Agent B", plus the earlier timing Workspaces. Delete them from the home page when they're no longer useful.
