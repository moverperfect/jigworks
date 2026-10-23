# How Workspaces, Conversations and Turns map onto Think

Researched 2026-10-13. Source code and repo docs are from cloudflare/agents at [`b7c6ab9`][sha] (2026-10-12): `agents` 0.28.0, `@cloudflare/think` 0.20.2, `@cloudflare/shell` 0.4.3. Pages on developers.cloudflare.com are cited with their "Last updated" date. In several places they lag the repo, and §7 lists where. "(inferred)" marks my own reading. No source states those points directly.

Related: [cloudflare-platform.md](./cloudflare-platform.md) §3 covers Think, `Workspace` and the bash tool in general, pinned to the older `7945da9`. This note covers how our domain maps onto them.

## Implications for our design

The two candidate mappings:

- **(A)** One Think DO per Workspace, with each Conversation as a session inside it.
- **(B)** One Think DO per Conversation, with the files in a separate Workspace DO.

**Think supports (B) and does not support (A).** A Think instance holds exactly one conversation. The chat WebSocket protocol has no field for choosing a conversation. A client chooses one by connecting to that conversation's DO. Cloudflare wrote up a "many sessions inside one Think" design and rejected it, and their reference multi-chat app is (B). Building (A) would mean a turn queue, stream buffer, message cache and recovery fiber per conversation inside Think. That is a fork, not configuration (inferred). See §1.

Here is (B) for us, following Cloudflare's per-user hub pattern with the hub keyed per Workspace instead (inferred):

1. **Workspace DO, one per Workspace.** It owns the files, as a `Workspace` from `@cloudflare/shell` on its own SQLite. It also owns the list of Conversations, the `onChange` broadcast to the editor, the Turn lease and the Check. It doesn't need to extend Think.
2. **Conversation DO, one per Conversation.** It is a `Think` subclass that overrides `workspace` with a proxy forwarding each file call to the Workspace DO over RPC. `examples/assistant` does exactly this in about 90 lines (§2).
3. **Top-level DOs, not facets.** `examples/assistant` hosts each chat as a facet of the per-user directory. Cloudflare's accepted RFC replaces that with one top-level DO per chat behind a hub, and `RoutedAgents` (`agents/routing`, since 0.23.0) implements the hub's catalog and WebSocket forwarding. The repo docs now say not to use facets for many chats per user, and nothing moves facet storage to a top-level DO later. One point cuts the other way. Our one-Turn rule removes most of the facet cost, because only one Conversation is busy at a time, and facets make every workspace RPC in-process. I'd still start top-level because that is where Cloudflare's own examples are moving (§3).

**One Turn per Workspace is ours to build.** Think queues turns inside one Conversation DO, because `messageConcurrency` defaults to `"queue"`. Separate Conversation DOs run turns in parallel. Cloudflare's RFC lists "two Chat agents for one user running turns concurrently" as an acceptance test, and `Workspace` has no locking (§5). So the Workspace DO has to hold a Turn lease (inferred):

- Route each Developer message through the Workspace DO. It checks the lease, then calls a method on the Conversation DO that starts the Turn with `submitMessages()`. The Conversation DO releases the lease from `onChatResponse` or `onChatError`. The chat socket is then used for streaming only.
- Gating inside the Conversation DO is weaker. I found no hook that refuses a turn Think has already accepted. `beforeToolCall` can return `block` for write tools, but the model still runs and bills.
- Think's recovery can resume an interrupted Turn after eviction, so keep the lease in the Workspace DO's SQLite with an expiry. In-memory state would not survive the eviction.
- The same lease lets the Workspace DO refuse editor saves while a Turn runs, which the glossary requires.

**Watch what Think writes into a shared Workspace.** Media eviction writes aged attachments to `/attachments/evicted/` through `this.workspace`. If the Workspace is shared, those files land in the Developer's project. Set `mediaEviction = false`, or have the proxy keep that path out of the Workspace (inferred). `fetchTools` spill and `skillWorkspace` are off by default (§2).

**Replace the bash tool instead of configuring it.** Think's `bash` is just-bash, and its options have no way to add commands. just-bash itself has `customCommands` and `defineCommand`, and Cloudflare's skill-script runner uses them. So define our own `bash` in `getTools()`, where a same-named custom tool wins, or set `workspaceBash = false` and add one. Run just-bash inside the Workspace DO behind one RPC (inferred). Before every script, the built-in tool copies the whole workspace into memory, up to 1,000 files, one `readFileBytes` per file. Over the proxy that is one RPC per file. Inside the Workspace DO, `tsc` can call the Check directly and `npm install` can call our type acquisition. That fits ADR 0001 and ADR 0002 (§4).

**Claude direct works. Prompt caching is ours to add.** `getModel()` can return `createAnthropic({ apiKey })(model)`. Think uses a returned `LanguageModel` as-is, with no AI Gateway. Think never sets Anthropic `cacheControl`. Its "prompt caching" docs only cover keeping the prompt prefix byte-stable between turns. We'd add cache breakpoints ourselves through `beforeTurn` or `beforeStep`, which can return `messages` and `providerOptions`, or through AI SDK model middleware (inferred). See §6.

**Trust the repo over developers.cloudflare.com for now.** The live Sessions page still documents `SessionManager`, which `agents` 0.23.0 removed. The live sub-agents page recommends sub-agents for open-ended sets of chats, and repo HEAD says the opposite (§7).

## Findings

### 1. One Think DO holds one conversation

- **Think's own header.** "Each instance holds one conversation in its own SQLite storage, backed by Sessions" ([think.ts L1-10][think-head]).
- **The multi-chat guide.** "A Think instance holds exactly one conversation. Putting every conversation in one Durable Object would serialize all of a user's turns on one single-threaded object, so each chat gets its own" ([multi-chat.md L6-19][mc-intro]). This guide exists in the repo but not on developers.cloudflare.com (§7).
- **Think binds one session at startup.** It installs one `Sessions` capability and wraps the default handle with `new ThinkSession(this.sessions.session(), ...)`, passing no ID ([think.ts L3655-3665][think-sessions], [L3846-3850][think-init]). The default ID is the empty string, "the primary path when one Durable Object owns one conversation" ([sessions.md L44][sess-default]).
- **Sessions can hold several handles, but Cloudflare doesn't recommend that for chats.** `sessions.session("support")` and `sessions.session("sales")` can share one DO. "For user-facing chat applications, prefer one Durable Object per conversation." Multiple handles are meant "for local branches, drafts, or application-specific namespaces" ([sessions.md L389-400][sess-multi]).
- **Cloudflare rejected multi-session inside Think.** `rfc-think-multi-session.md` has "Status: rejected". It says "One Think DO = one conversation. This is already how Think is built", and that putting `SessionManager` in Think "would force all of a user's conversations to serialize onto a single Durable Object" ([L1-34][rfc-ms]). A Think release removed the unused `session_id` scaffolding because "Think never actually had top-level multi-session support", calling the shipped model "one Think Durable Object per conversation" ([think CHANGELOG L1762-1766][think-cl]). The accepted replacement RFC lists "Adding multi-session storage inside `AIChatAgent` or `Think`" as a non-goal ([rfc-user-chat L590-600][rfc-uc-non]).
- **What the live Sessions page means by multi-session.** The page (updated 2026-06-05) says "`SessionManager` is a registry for multiple named sessions within a single Durable Object", imported from `agents/experimental/memory/session`. It mentions Think only as using `Session` "via `configureSession()`" ([Sessions][live-sessions]). That API is gone. `agents` 0.23.0 removed the subpath and `SessionManager`, and its migration note says "one `Sessions` capability holds many sessions by id; a user-facing conversation directory belongs to a parent or router Durable Object" ([agents CHANGELOG L367-372][agents-cl-rm]). When the live Think overview links to "a multi-session Think assistant", it means `examples/assistant`, where each session is its own Think DO ([Think][live-think], updated 2026-08-20).
- **The chat protocol has no conversation selector.** Client frames are `cf_agent_use_chat_request` (with `id` and `init`), `cf_agent_chat_messages`, `cf_agent_chat_clear`, request cancel, stream resume, tool result and tool approval. None of them carries a session or conversation ID ([wire-types.ts L179-259][wire-in], [protocol.ts L18-47][proto]).
- **How `examples/assistant` does multi-session.**
  - One `AssistantDirectory` DO per GitHub user holds the chat list. Each chat is a `MyAssistant` Think facet created by `this.subAgent(MyAssistant, id)` ([README L8-18, L99-116][ex-readme-arch], [agent.ts L174-195][ex-create]). Only `AssistantDirectory` has a DO binding ([wrangler.jsonc L23-38][ex-wrangler]).
  - The Worker finds the directory from the login cookie and forwards `/chat/sub/my-assistant/<chatId>` with `routeSubAgentRequest` ([server.ts L81-102][ex-server]). `onBeforeSubAgent` returns 404 for chat IDs the directory didn't create ([agent.ts L125-133][ex-gate]).
  - The browser holds two sockets. One goes to the directory for the sidebar, file events and MCP. The other goes to the active chat through `useAgent({ basePath: "chat", sub: [{ agent: "MyAssistant", name: chatId }] })` ([multi-chat.md L52-54, L312-328][mc-client], [client.tsx L490-503][ex-client]).

### 2. `this.workspace`: scope, construction, and bringing your own

- **Default.** If `workspace` is unset at startup, Think creates `new Workspace({ sql: this.ctx.storage.sql, name: () => this.name })` ([think.ts L3836-3843][think-init]). With no `namespace`, that is the table `cf_workspace_default` in the Think DO's own SQLite ([filesystem.ts L236-301][shell-ctor]). So by default each Think instance, and so each conversation, has its own files.
- **Override.** The field is typed `WorkspaceLike` "so subclasses can replace it with anything that satisfies the interface", and the comment says to "Override as a class field to skip the default init entirely" ([think.ts L3757-3778][think-ws]).
- **`WorkspaceLike`.** It is `readFile`, `readFileBytes`, `writeFile`, `readDir`, `rm`, `glob`, `mkdir` and `stat`, with optional `writeFileBytes`. Without `writeFileBytes`, media eviction and skills projection become no-ops with a warning ([tools/workspace.ts L8-41][ws-like]). `@cloudflare/shell`'s `WorkspaceFsLike` adds `appendFile`, `exists`, `lstat`, `cp`, `mv`, `symlink` and `readlink`. Codemode's `state.*` needs the wider type ([filesystem.ts L162-179][shell-fslike]).
- **Per-operation interfaces.** `ReadOperations`, `WriteOperations`, `EditOperations`, `ListOperations`, `FindOperations`, `DeleteOperations`, `GrepOperations` and `BashOperations` let each tool run against any backend ([tools/workspace.ts L43-99][ws-ops]). `createWorkspaceTools(workspace, { bash })` builds all eight tools from one `WorkspaceLike` ([L166-229][ws-create]). The live Tools page documents this as "Custom workspace backends" but only shows `ReadOperations` ([Tools][live-tools], updated 2026-08-18). The repo version lists all seven non-bash interfaces ([tools.md L556-602][doc-tools-custom]).
- **A Workspace in another DO works.** Nothing in Think requires the workspace to be local. The assistant's proxy is 16 one-line async methods that call the parent stub ([shared-workspace.ts L24-111][ex-shared]), matched by one-line delegates on the directory ([agent.ts L303-387][ex-dir-rpc]). The accepted RFC keeps these adapters for top-level chat DOs: "Only stub resolution changes from `parentAgent(AssistantDirectory)` to `getAgentByName(env.UserAgent, ownerName)`" ([rfc-user-chat L284-318][rfc-uc-ports]).
- **Two other routes (inferred).**
  - `Workspace` accepts any `SqlBackend` whose `query` and `run` may be async ([filesystem.ts L33-37, L96-116][shell-opts]). A backend that forwards SQL to the Workspace DO would work, but it sends more round trips than proxying file calls, and `onChange` would fire in the Conversation DO.
  - `Workspace` also accepts a D1 database directly, with one `namespace` per Workspace. Then `onChange` fires only for writes made through the same instance, so the editor would miss the Agent's writes.
- **How `examples/assistant` shares one.** The directory owns `new Workspace({ sql: this.ctx.storage.sql, name, onChange })`, and `onChange` broadcasts to every tab connected to the directory ([agent.ts L61-82][ex-dir-ws]). Each chat sets `override workspace: WorkspaceFsLike = new SharedWorkspace(() => this.parentAgent(AssistantDirectory))`. Because that is a class field, "Think never creates a per-chat `Workspace` at all" ([my-assistant/agent.ts L61-83][ex-chat-ws]). The same object feeds the built-in tools, `createWorkspaceTools(this.workspace)` inside `createExecuteTool`, fetch spill and skill scripts ([multi-chat.md L336-406][mc-ws]). Change events go to browser tabs, not to sibling chats ([README L236-245][ex-readme-ws]).
- **What else writes into it.** Media eviction writes `/attachments/evicted/<messageId>-<n>.<ext>` through `this.workspace` ([media-eviction.ts L333-339][media]). `fetchTools` spills large responses there when enabled. `skillWorkspace` defaults to `false` ([think.ts L3540-3547][think-skillws]). The extension host bridge reads and writes `this.workspace` too ([think.ts L8941-8975][think-host]).
- **No locking.** "Concurrent writes to the same path from multiple connections are last-write-wins" ([design/workspace.md L134][ws-lock]). The assistant README says "Serialization is per-file, not per-turn" ([README L233-235][ex-readme-ser]).

### 3. Sub-agents are facets with their own SQLite

- **What `subAgent()` creates.** `subAgent()` is a deprecated alias of `this.dynamicAgents.get()` ([agents index.ts L5638-5643][subagent]), which creates a workerd facet with `ctx.facets.get(...)` ([dynamic-agents.ts L694-698][facets]).
- **What a facet gets.** A facet has its own isolate and its own SQLite, which siblings and the parent can't see. It sits on the parent's machine, has no alarm slot of its own, and trees nest at most four levels ([sub-agents.md L93-103][sub-sem]). The live page agrees: "co-located Durable Objects with their own isolated SQLite storage" ([Sub-agents][live-sub], updated 2026-09-15).
- **A Think child gets its own workspace.** The default init uses `this.ctx.storage.sql`, so a Think child's default workspace lives in the child's database (inferred from [think.ts L3836-3843][think-init]). A child shares the parent's workspace only through a proxy override like §2's. Think has nothing built in for it.
- **Who holds the socket.** For a client connection to a facet, the parent "owns the native WebSocket for the connection's lifetime. Every subsequent frame wakes the root parent" ([sub-agents.md L413-421][sub-ws]). The multi-chat guide's Known limits says the same ([multi-chat.md L566-581][mc-limits]). A comment in the assistant's `client.tsx` claims frames "flow straight to the child" ([L490-497][ex-client]). The docs contradict it.
- **When to use them.** The repo doc says "Do not use dynamic agents to model an open-ended set of independent peers", and its table answers "Many chats / documents / sessions per user" with one top-level DO each plus a per-user index ([sub-agents.md L1-8, L445-483][sub-when]). The accepted RFC gives the reasons: the whole tree sits on one machine, facets have no alarms of their own, every frame wakes the root, and chat lifecycle gets tied to the parent ([rfc-user-chat L1-52, L78-97][rfc-uc-sum]).
- **The top-level alternative.** `RoutedAgents` implements the hub with a catalog plus request and WebSocket forwarding, and "Chat frames never wake the hub" ([routing.md L604-700][routing]). It shipped in 0.23.0 ([agents CHANGELOG L329][agents-cl-routed]). Its example target is a plain `Agent`, not Think ([examples/next/routing index.ts L83][ex-routing]). `examples/assistant` moves to a top-level binding in the RFC's Phase 3 ([L516-520][rfc-uc-p3]). At `b7c6ab9` it still uses facets.

### 4. The bash tool

- **It is just-bash.** The tool runs `new Bash({ files, cwd, defenseInDepth: true, network })` from `just-bash` ([tools/workspace.ts L1181-1261][ws-bash]). Think depends on `just-bash` ^3.0.2 ([think package.json][think-pkg]).
- **How it runs.** On each call it walks the workspace through `BashOperations` and copies every file into just-bash's memory. The defaults are at most 1,000 files and 1 MB per file, and skipped files are protected from write-back. It runs the script with a 30 s timeout, then diffs memory against the snapshot and writes the changes back ([L1148-1179, L1263-1317][ws-snap]). Over a proxy that means one `readDir` per directory and one `readFileBytes` per file on every call (inferred).
- **It takes no custom commands.** `BashToolOptions` has `ops`, `timeout`, `network`, `maxWorkspaceFiles`, `maxWorkspaceFileBytes` and `maxOutputBytes`, nothing else ([L1172-1179][ws-bash-opts]). The live Tools page lists the same options and says nothing about commands ([Tools][live-tools]).
- **just-bash does support custom commands.** Cloudflare's skill-script runner defines `workspace-read`, `workspace-list`, `workspace-glob`, `workspace-write` and `tool` with `defineCommand(name, async (args, ctx) => ({ stdout, stderr, exitCode }))` and passes them as `new Bash({ files, customCommands, defenseInDepth: true })`. Those commands make async RPC calls and read `ctx.stdin` ([skills/runner.ts L869-997][runner]). So `tsc` and `npm` can be commands that call our functions, in a bash tool we write (inferred).
- **How to replace it.** Tools merge in a fixed order, and "If a custom tool has the same name as a workspace tool, the custom tool wins" ([tools.md L5-15, L142][doc-tools-merge]). In the source, Think builds the workspace tools first and spreads `getTools()` after them on every turn ([think.ts L7457-7496][think-merge]).
- **Turning it on and off.** `workspaceBash = false` removes the tool, and an options object tunes it ([think.ts L3789-3796][think-bashfield], [Tools][live-tools]). It is a field per Think subclass. Think reads it on every turn, so an instance could also change it at runtime (inferred from [L7457-7459][think-merge]). `beforeTurn` can return `activeTools` to limit the tools for one turn ([tools.md L168-181][doc-tools-active]).

### 5. Concurrency

- **Inside one Think DO, turns queue.** Each instance has one in-memory `TurnQueue`, a "serial async queue" used "to prevent overlapping chat turns" ([think.ts L4789][think-tq], [turn-queue.ts L1-11][turnq]). `messageConcurrency` defaults to `"queue"`. The other strategies are `"latest"`, `"merge"`, `"drop"` and `debounce` ([think.ts L3553-3559][think-mc], [lifecycle.ts L330-355][mc-type], [client-tools.md L159-186][doc-ct]). These only apply to user submits. Regenerations, tool continuations, approvals, `saveMessages`, `submitMessages` and `continueLastTurn` always run one after another. A blocking `runTurn` can't be called from inside a turn ([index.md L298-305][doc-runturn]).
- **"Two sessions in one Think DO" can't happen,** since a Think DO has one conversation (§1). Two tabs on the same Conversation share its queue, and Think broadcasts the stream to both ([client-tools.md L226-233][doc-ct-tabs]).
- **Separate Think DOs run turns in parallel.** Facet siblings run "in parallel with siblings, on the same machine" ([sub-agents.md L76-91][sub-diagram]). The RFC puts "model-turn admission and concurrency policy" on each Chat agent and tests "two Chat agents for one user running turns concurrently" ([rfc-user-chat L150-164, L530-533][rfc-uc-chat]).
- **Nothing enforces one turn per workspace.** I found no such lock in Think, Sessions or `Workspace`. The multi-chat guide notes that the example "does not coordinate `deleteChat()` with a turn that is still running" ([multi-chat.md L596-600][mc-limits]).
- **Hooks we could build on.** `submitMessages()` durably accepts a turn, takes an idempotency key, and returns before inference starts ([programmatic-submissions.md L1-46, L185-193][doc-ps]). `beforeToolCall` can return `{ action: "block", reason }`, and the model sees the reason as the tool output ([lifecycle-hooks.md L477-495][doc-btc]). I found no documented hook that refuses a turn after Think has admitted it.

### 6. `getModel()` with `@ai-sdk/anthropic`, and prompt caching

- **Anthropic with our own key is supported.** `getModel()` may return "A fully-constructed AI SDK `LanguageModel`, for any other provider or for full control over provider/gateway options". The doc comment's example is `createOpenAI({ apiKey: this.env.OPENAI_API_KEY })("gpt-5.5")` ([think.ts L5169-5210][think-getmodel]). `resolveModel()` says "A `LanguageModel` is returned as-is" ([L5260-5270][think-resolve]). Only string IDs go through `workers-ai-provider`. A `@cf/...` ID calls Workers AI, and a slug like `"anthropic/claude-sonnet-4-5"` routes through AI Gateway ([L5271-5307][think-resolve]).
- **Cloudflare calls Anthropic directly in its own repo.** `examples/deploy-churn` builds `createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId)` ([server.ts L70-78][ex-churn]). The live Configuration page shows only Workers AI and describes `getModel()` as "Return the `LanguageModel` to use" ([Configuration][live-config], updated 2026-08-20).
- **Anthropic recovery.** To continue an interrupted turn, Think appends an ephemeral user message: "Continue your previous response from exactly where it left off. Do not repeat any of it." It does this because Claude 4.6+ rejects assistant prefill with a 400. The message is never persisted ([think.ts L1473-1495][think-ckpt]).
- **Think applies no Anthropic `cacheControl`.** Neither `cacheControl` nor `cache_control` appears in `packages/think/src` or `packages/agents/src` at `b7c6ab9`. Think's "Prompt caching" section is about keeping the prefix stable. The system prompt is frozen, read-time truncation moves only every `truncationStep` (8) messages, media eviction follows the same cutoff, and compaction rewrites once per run ([index.md L984-1004][doc-cache]). The live Sessions page's `withCachedPrompt()` freezes the system prompt and has nothing to do with provider caching ([Sessions][live-sessions]).
- **Where we could add it (inferred).** `beforeTurn` can return `messages` and `providerOptions`, and Think passes both to `streamText` ([think.ts L2845-2920][think-turncfg], [L7693-7718][think-stream]). `beforeStep` can return the same per step ([L3150-3171][think-stepcfg]). Cloudflare's `agent-think` wraps a `createAnthropic` model with `wrapLanguageModel` and `defaultSettingsMiddleware` to set Anthropic provider options ([agent-think/src/model.ts L41-76][agent-think-model]). I didn't check how `@ai-sdk/anthropic` expects cache breakpoints, because that is outside the sources for this note.

### 7. Where developers.cloudflare.com and the repo disagree

| Topic | Live page | Repo at `b7c6ab9` |
| --- | --- | --- |
| Multi-session | [Sessions][live-sessions] (2026-06-05) documents `SessionManager` in `agents/experimental/memory/session` | Removed in `agents` 0.23.0 ([CHANGELOG L367-372][agents-cl-rm]). [sessions.md][sess-multi] documents the `Sessions` capability instead |
| Many chats per user | [Sub-agents][live-sub] (2026-09-15) says "Use sub-agents when a single user or entity owns an open-ended set of long-lived agents", including chats | [sub-agents.md L1-8, L445-483][sub-when] says don't, and to use one top-level DO per chat |
| Multi-chat guide | No page. [Think][live-think] (2026-08-20) only links the example | [multi-chat.md][mc-intro] |
| `getModel()` | [Configuration][live-config] (2026-08-20) shows only `createWorkersAI` | String IDs, AI Gateway slugs and any `LanguageModel` ([think.ts L5169-5210][think-getmodel]) |

## Open questions

1. Can a just-bash custom command read the script's in-memory filesystem? The skills runner only uses `args` and `ctx.stdin`. The Think tool writes changes back only after the script ends ([L1238-1244][ws-bash]). So in `sed -i ... && tsc`, a `tsc` that reads the Workspace DO would see the files as they were before the `sed`. Check just-bash's command context before relying on it.
2. How should the Turn lease interact with recovery? Think can resume an interrupted Turn after eviction within its recovery budgets (see [cloudflare-platform.md](./cloudflare-platform.md) §3.4). The lease expiry needs to outlast that, and the release must also run when recovery gives up. Can throwing from `beforeTurn` refuse a turn cleanly, or does it go through `onChatError` and recovery? The docs don't say.
3. Does Think work as a `RoutedAgents` target? The routing example's target is a plain `Agent`, and the assistant's Phase 3 migration hasn't landed. Test resumable streams and recovery through the hub's WebSocket forwarding.
4. What does the proxy cost between top-level DOs that may sit on different machines? Cloudflare says "The SDK does not yet publish measured limits for this fan-out" ([multi-chat.md L582-587][mc-limits]). This decides whether the built-in bash tool's per-file snapshot is tolerable or whether bash has to run inside the Workspace DO.
5. Where should Anthropic cache breakpoints go, given Think appends a context reminder after the cached prefix and rewrites older messages every 8? Check `@ai-sdk/anthropic` and Anthropic's docs.
6. Should the Check run in the Workspace DO? ts-rust's WASM, the just-bash snapshot and the `Workspace` would then share one isolate's 128 MB.

[sha]: https://github.com/cloudflare/agents/tree/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a
[live-sessions]: https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/
[live-think]: https://developers.cloudflare.com/agents/harnesses/think/
[live-config]: https://developers.cloudflare.com/agents/harnesses/think/configuration/
[live-tools]: https://developers.cloudflare.com/agents/harnesses/think/tools/
[live-sub]: https://developers.cloudflare.com/agents/runtime/execution/sub-agents/
[think-head]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L1-L10
[think-ckpt]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L1473-L1495
[think-turncfg]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L2845-L2920
[think-stepcfg]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3150-L3171
[think-skillws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3540-L3547
[think-mc]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3553-L3559
[think-sessions]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3655-L3665
[think-ws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3757-L3778
[think-bashfield]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3789-L3796
[think-init]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L3836-L3850
[think-tq]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L4789
[think-getmodel]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L5169-L5210
[think-resolve]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L5260-L5307
[think-merge]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L7457-L7496
[think-stream]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L7693-L7718
[think-host]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/think.ts#L8941-L8975
[think-cl]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/CHANGELOG.md#L1762-L1766
[think-pkg]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/package.json#L23-L31
[ws-like]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/tools/workspace.ts#L8-L41
[ws-ops]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/tools/workspace.ts#L43-L99
[ws-create]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/tools/workspace.ts#L166-L229
[ws-bash-opts]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/tools/workspace.ts#L1172-L1179
[ws-bash]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/tools/workspace.ts#L1181-L1261
[ws-snap]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/tools/workspace.ts#L1148-L1317
[media]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/think/src/media-eviction.ts#L333-L339
[shell-opts]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/shell/src/filesystem.ts#L33-L116
[shell-fslike]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/shell/src/filesystem.ts#L162-L179
[shell-ctor]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/shell/src/filesystem.ts#L236-L301
[ws-lock]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/workspace.md#L134
[wire-in]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/chat/wire-types.ts#L179-L259
[proto]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/chat/protocol.ts#L18-L47
[turnq]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/chat/turn-queue.ts#L1-L11
[mc-type]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/chat/lifecycle.ts#L330-L355
[runner]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/skills/runner.ts#L869-L997
[subagent]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/index.ts#L5638-L5643
[facets]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/src/dynamic-agents/dynamic-agents.ts#L694-L698
[agents-cl-routed]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/CHANGELOG.md#L329
[agents-cl-rm]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/packages/agents/CHANGELOG.md#L367-L372
[sess-default]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/sessions.md#L44
[sess-multi]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/sessions.md#L389-L400
[sub-when]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/sub-agents.md#L445-L483
[sub-diagram]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/sub-agents.md#L76-L91
[sub-sem]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/sub-agents.md#L93-L103
[sub-ws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/sub-agents.md#L413-L421
[routing]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/agents/routing.md#L604-L700
[mc-intro]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/multi-chat.md#L6-L19
[mc-client]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/multi-chat.md#L52-L54
[mc-ws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/multi-chat.md#L336-L406
[mc-limits]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/multi-chat.md#L566-L605
[doc-tools-merge]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/tools.md#L5-L15
[doc-tools-active]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/tools.md#L168-L181
[doc-tools-custom]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/tools.md#L556-L602
[doc-ct]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/client-tools.md#L159-L186
[doc-ct-tabs]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/client-tools.md#L226-L233
[doc-runturn]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/index.md#L298-L305
[doc-cache]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/index.md#L984-L1004
[doc-ps]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/programmatic-submissions.md#L1-L46
[doc-btc]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/docs/think/lifecycle-hooks.md#L477-L495
[rfc-ms]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/rfc-think-multi-session.md#L1-L34
[rfc-uc-sum]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/rfc-user-chat-durable-objects.md#L1-L97
[rfc-uc-chat]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/rfc-user-chat-durable-objects.md#L150-L164
[rfc-uc-ports]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/rfc-user-chat-durable-objects.md#L284-L318
[rfc-uc-p3]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/rfc-user-chat-durable-objects.md#L516-L533
[rfc-uc-non]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/design/rfc-user-chat-durable-objects.md#L590-L600
[ex-readme-arch]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/README.md#L8-L18
[ex-readme-ser]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/README.md#L233-L235
[ex-readme-ws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/README.md#L236-L245
[ex-wrangler]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/wrangler.jsonc#L23-L38
[ex-dir-ws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/agents/assistant/agent.ts#L61-L82
[ex-gate]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/agents/assistant/agent.ts#L125-L133
[ex-create]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/agents/assistant/agent.ts#L174-L195
[ex-dir-rpc]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/agents/assistant/agent.ts#L303-L387
[ex-chat-ws]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/agents/assistant/agents/my-assistant/agent.ts#L61-L83
[ex-shared]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/agents/assistant/shared-workspace.ts#L24-L111
[ex-server]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/src/server.ts#L81-L102
[ex-client]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/assistant/src/client.tsx#L490-L503
[ex-routing]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/next/routing/src/index.ts#L83
[ex-churn]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/examples/deploy-churn/src/server.ts#L70-L78
[agent-think-model]: https://github.com/cloudflare/agents/blob/b7c6ab94dbe7b998ae9d85cb528eb1c39f02e00a/agent-think/src/model.ts#L41-L76
