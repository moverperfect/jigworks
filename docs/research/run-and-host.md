# Running and hosting the apps the Agent writes

Researched 2026-10-13 against developers.cloudflare.com, blog.cloudflare.com, MDN, the RFCs and Cloudflare GitHub repos. GitHub links are pinned to the commits I read:

- cloudflare/vibesdk [`9da158d`][vibe-sha] (2026-09-07). `main` was still at this commit on 2026-10-13.
- cloudflare/cloudflare-os [`8001c4b`][cfos-sha] (2026-10-13). That is 14 commits after the `8cbfb2b` read for the platform note, and none of them touch gadget hosting.
- cloudflare/cloudflare-os-starter [`3d21147`][cfos-st-sha] (2026-08-19).
- cloudflare/agents [`7945da9`][agents-sha] (2026-10-12).
- cloudflare/workerd [`9cdf380`][workerd-sha].
- `@cloudflare/worker-bundler` 0.2.6, the latest on npm (published 2026-10-07).

"Updated" dates are the "Last updated" stamps on doc pages. "(inferred)" marks my own reading where no source states it directly.

This note builds on [cloudflare-platform.md](./cloudflare-platform.md), mainly §4 (Dynamic Workers basics, limits, pricing) and §5 (vibesdk and Cloudflare OS). Facts already stated there are not repeated.

## Verdict

Yes. Our platform can serve both the Preview and the Deployment from Dynamic Workers, with app data in Durable Object Facets and static assets read from DO SQLite. No extra Cloudflare product is required. Cloudflare OS already hosts its gadgets permanently this way. Cloudflare's docs list "Platforms: Run applications uploaded by your users" as a use case. Cost is negligible at our scale.

The weak points are maturity, coupling and URLs:

- **Maturity.** Dynamic Workers are still open beta with no SLA, and worker-bundler is "Not recommended for production use".
- **Coupling.** Every platform deploy restarts the Durable Objects that host the apps.
- **URLs.** The URL scheme is the hardest decision. Under `platform.<domain>`, `<app>.platform.<domain>` needs Advanced Certificate Manager ($10/month). Worse, it puts agent-written code on the same site as the platform and every other site on `<domain>`. A separate registrable domain on a Free zone avoids both problems for the price of a domain registration.

## Recommended setup

These are inferred from the findings below unless a source is linked.

1. **Host in a separate Durable Object per Workspace.** Keep build records, both facets and runtime logs in a host Durable Object (DO), not in the Workspace's Think DO. Each app request passes through the parent DO's `fetch` before it reaches the facet ([worker-bundler README][wb-facet], [vibesdk][v-split]). A Check that burns seconds of CPU in the Workspace DO would otherwise stall the Preview and the Deployment. App storage also counts toward the parent DO's 10 GB (§1.4). This doesn't contradict [ADR-0003](../adr/0003-one-durable-object-per-workspace.md), because files and the Conversation stay in the Workspace DO. It does add a second DO per Workspace, which may be worth an ADR.
2. **Shape apps as one Durable Object class.** The Template's server entry is `export class App extends DurableObject`, and its `fetch` hands off to Hono. The host mounts it with `ctx.facets.get("preview" | "deployment", () => ({ class: worker.getDurableObjectClass("App") }))`. Use two facet names so Preview experiments can't touch Deployment data. vibesdk and Cloudflare OS both allow exactly one class per app (§1.4).
3. **Use stable IDs per build.**
   - Preview: `LOADER.get("p:<workspace>:<buildHash>")`. Call `ctx.facets.abort("preview")` after each new build so the next request loads the new class while storage is kept ([facets docs][dw-facets]).
   - Deployment: `LOADER.get("d:<workspace>:<deploymentId>")`, read from an immutable build record. Rollback is a pointer change.
   - Set `limits: { cpuMs, subRequests }` on both ([custom limits][dw-ulimits]).
4. **Store assets in SQLite.**
   - Save `createApp`'s `assetManifest`, `assetConfig` and modules.
   - Store each asset in its own row keyed by content hash. Chunk anything near 2 MB.
   - Serve with worker-bundler's `handleAssetRequest` and a custom `AssetStorage` whose `get(pathname)` reads SQLite ([README][wb-assets]).
   - Default to `not_found_handling: "single-page-application"`.
   - Don't copy vibesdk's single JSON row per branch, which caps a whole app at about 2 MB (§1.7).
   - Optionally pass `ASSETS: ctx.exports.AssetBinding({ props })` into `env` so app code can call `env.ASSETS.fetch()`, as the [static assets docs][dw-assets] show.
5. **Limit egress and pass capabilities, not bindings.**
   - Set `globalOutbound` explicitly. If it is omitted, the app inherits the platform's internet access ([API reference][dw-api]).
   - Start with `null`. Later, use an `HttpGateway` entrypoint that allowlists hosts and injects per-Workspace secrets, so app code never holds them ([egress control][dw-egress]).
   - `env` holds only plain values and `ctx.exports` loopback entrypoints with props. Real KV, D1, R2 or Queue bindings can't be passed, which suits [ADR-0004](../adr/0004-durable-objects-are-the-only-storage.md).
6. **Pin a compatibility date.** Use 2026-08-04 or later, which turns on `nodejs_compat` by default ([compat flags][compat]). Or pass through the app's own wrangler date and flags. vibesdk hard-codes `2025-04-01` with no flags, so Node built-ins break in its previews (§1.6).
7. **Capture logs.**
   - **Server side.** Set `tails: [ctx.exports.AppTail({ props: { workspaceId, slot } })]`. The tail handler writes `logs`, `exceptions` and `outcome` into a capped table in the host DO, and the Agent reads that table through a tool. This is the [observability docs][dw-obs] pattern, and Cloudflare OS does the same ([overseer.ts][o-tail]).
   - **Browser side.** Add a small script to Preview HTML with `HTMLRewriter`. It reports `window.onerror`, `unhandledrejection` and `console.error` to the platform.
   - vibesdk's headless-browser approach needs Browser Rendering, a separately billed product. We don't need it.
8. **Put app URLs on a separate registrable domain.**
   - Use a Free zone. Universal SSL covers `<apps-domain>` and `*.<apps-domain>` ([limitations][ussl-lim]).
   - Add a proxied wildcard DNS record, which all plans support ([wildcard DNS][wild-dns]), and one Worker route `*.<apps-domain>/*` to the platform Worker ([routes][routes]).
   - Hostnames must use the first label only, for example `<slug>.<apps-domain>` for a Deployment and `<workspace>-preview.<apps-domain>` for a Preview.
   - Fallback: `*.platform.<domain>` with ACM at $10/month per zone, accepting the same-site risks in §4.3.
   - *Decided:* [ADR 0008](../adr/0008-apps-live-under-the-platforms-hostname.md) first took the fallback. [ADR 0012](../adr/0012-apps-live-on-a-domain-of-their-own.md) later replaced ADR 0008 with this recommendation.
9. **Auth.**
   - Add a second Access application on `*.<apps-domain>` with the same identity provider. SSO through the team domain means no second login ([session management][acc-session]).
   - The platform Worker verifies that application's own AUD. A token minted for the apps domain can't be replayed against the platform ([validate JWT][acc-jwt]).
   - For a Preview, also check that the email owns the Workspace.
   - Strip `Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email` and the `CF_Authorization` cookie before forwarding a request into app code. If an app needs the caller's identity, send it as a header the platform sets.
   - On the platform itself, set the Access cookie to `SameSite=Lax` and check `Origin` on every API call and WebSocket upgrade, as Cloudflare OS does ([server.ts][o-origin]). Under [ADR 0008](../adr/0008-apps-live-under-the-platforms-hostname.md) apps are the same site as the platform, so `SameSite` doesn't stop them, and the `Origin` check is the only defence. [ADR 0012](../adr/0012-apps-live-on-a-domain-of-their-own.md) has since moved apps to a domain of their own. Access's cookie is still `SameSite=None` unless the Operator chooses Lax, so the `Origin` check still matters.
10. **Embedding the Preview.** Opening the Preview in its own tab works with Access as is. Inside an iframe on the platform page, Access cookies are third-party, so test the Access redirect there first. If it fails, use vibesdk's pattern for preview hosts. The platform mints a short-lived signed `?t=` token, and the preview host exchanges it for a host-only `HttpOnly; Secure; SameSite=None; Partitioned` cookie ([spacePreviewToken.ts][v-cookie]).

**Paid products.** None is needed beyond Workers Paid plus a domain registration. These become optional costs:

- ACM at $10/month per zone, if we use `*.platform.<domain>` ([Sandbox production guide][sandbox-prod]).
- Workers for Platforms (WfP) at $25/month, if Deployments move off Dynamic Workers (§3.1).
- Dynamic Worker overage at $0.002 per worker per day. That is about $15/month for a heavy team of ten (§2).
- Zero Trust, which is free up to 50 users ([cloudflare-platform.md §7](./cloudflare-platform.md#7-auth-cloudflare-access)).

**Main risks.**

1. Open beta and no SLA. worker-bundler is 0.x and "Not recommended for production use" ([README][wb-readme]).
2. Platform deploys restart every DO, which drops app WebSockets and restarts Deployments ([cloudflare-platform.md §1](./cloudflare-platform.md#1-workers-limits)). A WfP Deployment would not share this.
3. WebSocket upgrades into a facet, and facet alarms, are undocumented. vibesdk relies on the first, and nobody documents the second (§1.1, §1.8).
4. Tail events arrive only when a request completes, so logs from a long WebSocket session arrive late (inferred, §1.5).
5. If we put apps under `<domain>`, any app's JavaScript can set cookies for all of `<domain>` (§4.3).

## Findings

### 1. Dynamic Workers in depth

#### 1.1 Serving HTTP and WebSockets

- **Forwarding.** `env.LOADER.get(id, cb)` returns a `WorkerStub` synchronously. `worker.getEntrypoint().fetch(request)` forwards a request ([API reference][dw-api], updated 2026-10-12).
  - Named entrypoints work too, for example `worker.getEntrypoint("Agent").run()` over RPC ([bindings][dw-bind], updated 2026-10-12).
  - workerd types `getEntrypoint(name?, { props, limits })` and `getDurableObjectClass(name?)` ([worker-loader.h][workerd-wl-h]).
  - The Agents playground forwards with `entrypoint.fetch(request)` and treats a status of 500 or above as an app error ([server.ts L74-L100][pg-fwd]).
- **From a Worker or a DO.** The binding works in both. At most 4 Dynamic Workers can have requests in flight per Worker request, and 10 per DO. "Multiple in-flight requests to the same Dynamic Worker count as one toward this limit" ([platform limits][dw-plimits], updated 2026-08-27).
- **Facets need a DO.** A facet is mounted with `ctx.facets`, so only a DO host can use one (§1.4).
- **WebSockets.** No Cloudflare doc covers an upgrade through a Dynamic Worker.
  - `getEntrypoint()` and a facet stub are ordinary `Fetcher`s, so a 101 should pass through as it does for service bindings (inferred).
  - vibesdk relies on this. "everything else (including WebSocket upgrades) is forwarded into the Facet" ([durable-object.ts L646-L665][v-ws]). Its model skill teaches `ctx.acceptWebSocket` hibernation inside the App facet ([SKILL.md L166-L198][v-skill-ws]).
  - A plain loaded Worker isn't a DO, so it can't use the Hibernation API. Facets can (inferred from workerd's facet-aware hibernation code).
  - vibesdk avoids `ctx.facets.delete()` because it "breaks any active WebSocket connections" ([durable-object.ts L809-L824][v-reset]).

#### 1.2 Startup and limits

- **Startup.** "An isolate takes a few milliseconds to start" and "uses a few megabytes of memory" ([blog][dw-blog], 2026-03-24).
  - `load(code)` is "equivalent to calling `get()` with a null ID" ([changelog][dw-cl]). It builds a new isolate every time and counts as a new Dynamic Worker on every call ([pricing][dw-price]).
  - `get()` reuse is best-effort. "A later call with the same ID may start a new isolate from scratch." "The callback passed to `loader.get()` could run any number of times, although it is unusual for it to run more than once" ([API reference][dw-api]).
  - Startup CPU is billed: "The compute required to initialize the isolate and parse your code" ([pricing][dw-price]).
- **CPU and subrequests.** "By default, each Dynamic Worker invocation uses your Workers plan limits for CPU time and subrequests."
  - `limits: { cpuMs, subRequests }` can go in `WorkerCode` or in `getEntrypoint(null, { limits })`. The lower of the two wins.
  - At the limit the Dynamic Worker "immediately throws an exception" ([custom limits][dw-ulimits], updated 2026-10-12).
  - There is no memory option.
- **Memory.** No limit specific to Dynamic Workers is documented. Each new ID gets its own isolate, so it presumably has its own 128 MB rather than sharing the host's (inferred from [API reference][dw-api] and [Workers limits][wl]). Tail `outcome` includes `exceededMemory` and `exceededCpu` ([tail handler][tail]).
- **Size.** Open-source workerd caps module bodies at 64 MB and the serialized `env` at 1 MB (`MAX_DYNAMIC_WORKER_CODE_SIZE`, `MAX_DYNAMIC_WORKER_ENV_SIZE` in [worker-loader.c++][workerd-wl-cc]). Production may differ.
- **Code is not kept.** The host must hand over the code again whenever the callback runs. The facets page says "In production, you would typically store the dynamic code itself in the supervisor's database" ([facets][dw-facets]).

#### 1.3 What loaded code can receive in `env`

- **Allowed types.** "Structured cloneable types; Service Bindings, including loopback bindings from `ctx.exports`" ([API reference][dw-api]).
- **Real resource bindings can't be passed.** "To pass resources like a KV namespace or R2 bucket to a Dynamic Worker, you need to bind the resource to your loader Worker and create a custom binding that wraps it." The docs' wrapper is a `WorkerEntrypoint` keyed by `props.prefix` ([bindings][dw-bind]).
  - workerd refuses to serialize a KV binding. "A KV namespace binding cannot be serialized."
  - `DurableObjectNamespace` has no serializer. A `DurableObjectClass` can be passed, but "The only use of this type is to pass to `ctx.facets.get()`" (workerd source, read on `main`).
- **Props are private.** "Only the loader Worker has access to the props. The Dynamic Worker never sees them." "Stubs have no global identifier and cannot be forged" ([bindings][dw-bind]).
- **RPC stubs in practice.** Cloudflare OS says "At present the `env` of a dynamic isolate can contain ServiceStubs but cannot contain RpcStubs". It therefore wraps every capability as `ctx.exports.GatekeeperLoopback({ props })` ([overseer.ts L2403-L2430][o-env]). That conflicts with the general RPC docs, so use `ctx.exports` loopbacks.
- **Direction.** "Whatever you bind to a Worker today, you will soon be able to bind dynamically" ([Dynamic Workflows blog][dwf-blog], 2026-05-01).

#### 1.4 Durable Object Facets

- **API** ([facets][dw-facets], updated 2026-10-12):
  - `ctx.facets.get(name, cb)` returns a stub that "behaves like a Durable Object stub". `cb` returns `{ class, id? }`, and without `id` the facet "inherits the parent Durable Object's ID". The callback runs only if the facet hasn't started or has hibernated. Otherwise the running facet is reused.
  - `abort(name, reason)` "Shuts down a running facet and invalidates all existing stubs… The facet's storage is preserved." Use it to pick up new code. worker-bundler shows the same ([README L366-L425][wb-facet]).
  - `delete(name)` "Aborts the facet (if running) and permanently deletes its SQLite database."
- **Storage.** "Each facet has its own SQLite database, separate from the supervisor's." "The supervisor's database and the facet's database are stored together as part of the same overall Durable Object" ([facets][dw-facets]). So facet data counts toward the parent's 10 GB (inferred). "One Durable Object can have any number of facets (subject to storage limits)" ([facets blog][facets-blog], 2026-04-13).
- **Several classes per app.** This should work, with one facet per `getDurableObjectClass(name)` (inferred). The app code can't call `env.X.idFromName()`, though, because there is no namespace binding, so the host would have to broker it (inferred). Both reference platforms restrict apps to one class:
  - vibesdk rejects DO bindings: "The platform runs your app as a single Durable Object" ([deploy-engine.ts L172-L176][v-onedo]).
  - Cloudflare OS: "The class must be exported under the name `Gadget`" ([agent.ts L637][o-agent-637]).
- **Alarms.** No doc or source says whether a facet can set an alarm. Cloudflare OS schedules through its own scheduler DO and RPC instead ([gatekeeper-scheduler README][o-sched]).
- **A vibesdk bug to avoid.** vibesdk never calls `abort()`. It assumes `facets.get()` re-runs the callback after a redeploy, which the docs contradict, so a running facet can keep old code ([durable-object.ts L741-L744][v-abort], inferred).

#### 1.5 Observability

- **Logs are discarded by default.** "Workers Logs only captures log output from the loader Worker itself." "By default, those logs are discarded after the Dynamic Worker finishes" ([observability][dw-obs], updated 2026-10-12).
- **`tails` is the documented way to capture them.** "A tail event is delivered to the Tail Worker when a request to the dynamically-loaded Worker completes" ([API reference][dw-api]).
  - The tail can be an entrypoint in the host, passed as `ctx.exports.X({ props })`.
  - Each `TraceItem` has `logs` (level, message, timestamp), `exceptions` (name, message, stack), `event.request`, and `outcome` (`ok`, `exception`, `exceededCpu`, `exceededMemory`, `canceled`…) ([tail handler][tail], updated 2026-06-15).
  - "Tail Workers run asynchronously after the Dynamic Worker has already sent its response" ([observability][dw-obs]). A WebSocket request completes only when the socket closes, so its logs come late (inferred).
  - Streaming tails exist in workerd but need `allowExperimental`, which is not usable in production ([worker-loader.c++][workerd-wl-cc]).
- **Reference code.**
  - The Agents playground's `DynamicWorkerTail` sends structured entries to a `LogSession` DO over RPC, keyed by `props.workerId` ([logging.ts L149-L195][pg-log], [server.ts L217-L252][pg-load]).
  - Cloudflare OS's `GadgetTailLoopback` sends logs to the workspace DO, which fans them out in memory to subscribed browsers without storing them ([overseer.ts L10162-L10247][o-tail]).
  - In Cloudflare OS, the Developer clicks "Send N captured errors to chat". The agent doesn't get the logs automatically. Its starter says to "never collect errors from gadget-authored/user-authored code automatically" into the platform's own error tracking ([observability.md L119][o-st-obs]).
- **vibesdk has no server-side capture.** It sets no `tails`. Runtime feedback comes from a `get_browser_console_logs` tool that loads the signed preview URL in Browser Rendering with Puppeteer ([browser-logs-tool.ts L57-L78][v-blogs], [capture-core.ts L30-L76][v-capture]). The system prompt requires "a clean `get_browser_console_logs` check" before a building turn ends ([think.ts L322-L327][v-prompt]).

#### 1.6 Egress and compatibility

- **`globalOutbound`.** "If `globalOutbound` is not specified, the default is to inherit the parent's network access, which usually means the dynamic Worker has full access to the public Internet." With `null`, "Both `fetch()` and `connect()` throw exceptions." It can be any service binding, including a `ctx.exports` loopback ([API reference][dw-api]).
  - The gateway pattern "intercepts every `fetch()` and `connect()` call" and can inject credentials keyed by `ctx.props`. "The dynamic Worker never has access to `API_TOKEN`" ([egress control][dw-egress]).
  - The documented example implements only `fetch()`, so how a gateway handles `connect()` is unclear.
- **What the references set.**
  - vibesdk sets no `globalOutbound`, so its apps have open internet access ([durable-object.ts L745-L760][v-loader]).
  - Cloudflare OS sets `globalOutbound: null` ([overseer.ts L4353-L4379][o-loader]).
  - The playground sets `null` ([server.ts L217-L252][pg-load]).
- **Compatibility dates.**
  - The docs give no allowed range. workerd rejects future dates ("Can't set compatibility date in the future"), and Workers "will support old compatibility dates forever". So any past date should work (inferred).
  - "For compatibility dates of `2026-08-04` or later, Workers enables both `nodejs_compat` and `nodejs_compat_v2` by default" ([compat flags][compat], updated 2026-09-18).
  - Experimental flags need the host to have `experimental`, and "Experimental flags cannot be enabled in production" ([API reference][dw-api]).
  - In use: vibesdk `2025-04-01` with no flags. Cloudflare OS `2026-02-01` with `allow_irrevocable_stub_storage`. The playground uses the app's wrangler values, falling back to `2026-01-01`.

#### 1.7 Static assets without R2 or KV

- **The docs use KV.** The static assets page keeps assets and a manifest in KV under `project/{projectId}/…` and recommends R2 for large files. It never mentions DO storage. The host serves assets through an `AssetBinding` entrypoint passed as `env.ASSETS`, and the app calls `env.ASSETS.fetch(request)` for non-API paths ([static assets][dw-assets], updated 2026-05-05).
- **worker-bundler makes the storage pluggable** ([README L181-L355][wb-assets]):
  - `createApp` returns `assets`, `assetManifest` and `assetConfig` "for host-side serving". They are not embedded in the isolate.
  - `handleAssetRequest(request, manifest, storage, config)` returns `Response | null`.
  - `AssetStorage` is just `get(pathname)`, returning a stream, ArrayBuffer, string or null. The README's backends are memory, KV, R2 and `@cloudflare/shell` Workspace. A DO-SQLite backend is a few lines (inferred).
  - Config covers `html_handling` (four modes), `not_found_handling` (`single-page-application`, `404-page`, `none`), redirects and headers.
  - Hashed files get `max-age=31536000, immutable`. HTML gets `max-age=0, must-revalidate`. ETag and 304 are handled.
- **How vibesdk's SpaceDO does it:**
  - **Storage.** One row per branch in `deployments(branch, commit_hash, main_module, modules, assets, asset_config, …)` ([schema L133-L147][v-schema]). The whole `{path: content}` asset map is one JSON TEXT value ([deploy-engine.ts L129-L141][v-persist]), so modules and assets together must fit the 2 MB row limit (inferred). Files are read as strings, so binaries are probably damaged (inferred).
  - **Serving.** Each request rebuilds `buildAssetManifest` plus `createMemoryStorage` from that row, cached in memory for 8 entries and 5 minutes ([L703-L732][v-serve], [L78-L87][v-cache]). If `handleAssetRequest` returns `null`, the request goes to the facet ([L675-L695][v-decide]). The SPA fallback applies only when `Accept` includes `text/html`.

#### 1.8 Cron, alarms and queues

- No Dynamic Workers doc mentions `scheduled`, `queue` or `email` handlers for loaded code.
  - In workerd, `Fetcher.scheduled` and `Fetcher.queue` exist only behind a flag marked experimental, so the host can't call them in production (workerd `api/http.h` and `compatibility-date.capnp`, read on `main`).
- The workaround is for the host's own Cron Trigger or DO alarm to call an RPC method that the app exports (inferred). WfP has the same rule for its user Workers (§3.1).
- Durable execution is available through Dynamic Workflows (`@cloudflare/dynamic-workflows`) ([docs][dw-wf]).

### 2. Dynamic Workers as long-term hosting

- **Cloudflare positions them for hosting, but only in beta.**
  - The overview lists "Platforms: Run applications uploaded by your users" and "Fast development and previews" ([overview][dw], updated 2026-10-12).
  - The facets blog: "build platforms that run persistent, stateful code generated on-the-fly" ([facets blog][facets-blog]).
  - The launch blog cites Zite, which "now services millions of execution requests daily" ([blog][dw-blog]).
  - The product is still "in open beta on the Workers Paid plan" ([Dynamic Workflows blog][dwf-blog]). I found no SLA and no guidance on long-term hosting.
- **Cloudflare's reference architectures host deployed apps elsewhere.**
  - The Enterprise AI Vibe Coding Platform uses "Dynamic Workers for fast code validation and containers for full application previews", and "Deployed applications are hosted on Workers for Platforms" ([reference architecture][ra-enterprise], updated 2026-09-28).
  - vibesdk does the same. Its Dynamic Worker is preview-only, and "Deploy" republishes the bundle to WfP or to the user's own account ([think.ts L908-L912][v-deploy-branch]).
- **Cloudflare OS hosts gadgets permanently with Dynamic Workers.** Every path that runs a gadget goes through `LOADER.get`: the owner's UI, collaborators, exports, hooks and persistent callbacks. Nothing is ever deployed as a normal Worker (inferred from [overseer.ts][o-loader]).
  - The ID is `${ctx.id}.${codeVersion}.${gadgetId}`, where `codeVersion` is a counter. A chat draft appends `.${chatId}.${sequence}` ([L4318-L4332][o-id]). `bumpVersion()` aborts the affected facets ([L5683-L5699][o-bump]).
  - There is no build step. Each `.js` file is loaded as written, with `mainModule: "server.js"`.
  - The README still says "Early access… still has many rough edges" ([README L44-L48][o-readme-ea]).
- **What counts as a "unique worker".** "A Dynamic Worker is uniquely identified by its Worker ID and code — if either changes, it counts as a new Dynamic Worker. The count resets daily" ([pricing][dw-price], updated 2026-06-11).
  - Same ID and same code counts once, however many calls. `load()` or no ID counts once per invocation.
  - Pricing is 1,000 unique a month included, then "+$0.002 per Dynamic Worker per day". Billing started 2026-05-26.
  - The page mixes a monthly allowance with a daily count. My reading is that each (ID, code) pair loaded on a given day is one unit that day (inferred).
  - Requests and CPU are billed as normal Workers usage. "Subsequent calls on the returned stub are not billed as separate requests."
- **Cost example (inferred).**
  - Ten Developers each load 40 Preview builds a working day: 10 × 40 × 21 ≈ 8,400 a month.
  - Twenty Deployments are each used daily: 20 × 30 = 600 a month.
  - That totals about 9,000, minus 1,000 included, times $0.002 ≈ $16/month.

### 3. Other ways to host

#### 3.1 Workers for Platforms

- **Pricing.** $25/month with 20M requests, 60M CPU ms and 1,000 scripts included. Extra scripts are $0.02 each. "Max of 30 seconds of CPU time per invocation" ([pricing][wfp-price], updated 2026-04-21). Whether Workers Paid is needed as well isn't stated (inferred yes).
- **Limits** ([limits][wfp-limits], updated 2026-10-13):
  - Unlimited scripts and DO namespaces.
  - "User Workers can only be invoked by your dynamic dispatch Worker". They get no Cron Triggers and can't consume queues.
  - "`caches.default` is disabled for namespaced scripts."
  - "Gradual Deployments is not supported yet for user Workers." Version URLs are "not generated for Workers for Platforms user Workers" ([version URLs][version-urls]).
- **Model.**
  - One namespace for everything: "Do not create a namespace per customer" ([how it works][wfp-how]).
  - The dispatch Worker calls `env.DISPATCHER.get(name, { props }, { outbound, limits })`. Props "are visible to the user code" ([dynamic dispatch][wfp-dispatch]).
  - An outbound Worker sees every user `fetch()` but not fetches from Durable Objects ([outbound Workers][wfp-outbound]).
- **Bindings.** User Workers can have KV, R2, D1 and DO bindings, declared in the upload metadata ([bindings][wfp-bind]).
- **Static assets.** Supported since 2025-01-31 through the upload session flow ([static assets][wfp-assets], updated 2026-10-12):
  1. `POST …/dispatch/namespaces/{ns}/scripts/{script}/assets-upload-session` with a manifest of 32-hex hashes and sizes. The response holds a one-hour `jwt` and `buckets`.
  2. `POST /accounts/{id}/workers/assets/upload?base64=true` once per bucket, authorized with that JWT. The last upload returns a completion `jwt`.
  3. `PUT …/dispatch/namespaces/{ns}/scripts/{script}`, multipart, with `metadata.assets.jwt`.
- **Uploading from inside a Worker** needs an API token with "Workers Scripts Write" ([API][wfp-upload-api]). vibesdk does all three steps with `fetch` ([cloudflare-api.ts][v-api]).
- **Hostnames.** Use a `*/*` or `*.saas.com/*` route to the dispatch Worker, plus a dummy DNS record ([hostname routing][wfp-host], updated 2026-09-24). Cloudflare for SaaS custom hostnames include 100, then cost $0.10 each, and wildcard custom hostnames are Enterprise-only ([SaaS plans][saas-plans]).
- **Observability.** Workers Logs and Logpush work per user Worker or per namespace ([observability][wfp-obs]).

#### 3.2 Normal Workers on our own account via the Scripts API

- **Upload.** `PUT /accounts/{id}/workers/scripts/{name}` takes the same multipart format, with `main_module`, `bindings`, `compatibility_date`, `compatibility_flags`, `assets.jwt`, `migrations`, `observability` and `limits.cpu_ms` ([API][scripts-api], [metadata][mp-meta]). The static-assets session is the same three steps without the namespace ([direct upload][direct-upload], updated 2026-08-10).
- **Versions and deployments.** `POST …/scripts/{name}/versions` uploads without deploying, and `…/deployments` splits traffic by percentage ([versions][versions]). A beta JSON "Workers" API exists, but "See the multipart/form-data API below for the stable API" ([changelog][beta-api-cl]).
- **Hostnames.** The workers.dev subdomain is enabled with `POST …/scripts/{name}/subdomain`. A Custom Domain is attached with `PUT /accounts/{id}/workers/domains` ([API][domains-api]).
- **Permissions.** Account "Workers Scripts Write", plus zone "Workers Routes Write" for routes ([permissions][perms]).
- **Limits.**
  - 500 Workers per account on Paid ("If you need a higher Worker limit, use Workers for Platforms"), 100 Custom Domains and 1,000 routes per zone ([Workers limits][wl]).
  - The API allows 1,200 requests per 5 minutes per user ([API limits][api-limits]).
  - Version URLs are "not generated for Workers that implement a Durable Object" ([version URLs][version-urls]).
- **vibesdk's `ENABLE_USER_ACCOUNT_DEPLOY`.**
  - Credentials come from Cloudflare OAuth, not a pasted token. The scopes include `workers-scripts.write` and `offline_access` ([cloudflare-connect.ts L16-L39][v-oauth]).
  - It runs the asset session, the bucket uploads and the script `PUT` without a namespace. Then it enables the script's workers.dev subdomain and returns `https://<script>.<subdomain>.workers.dev` ([think.ts L905-L987][v-userdeploy], [cloudflare-api.ts L297-L328][v-subdomain]).
  - It wraps the bundle in a generated `index.js` that serves `env.ASSETS` first, falls back to `/index.html`, then calls a real `VIBE_APP` DO namespace with `new_sqlite_classes: ['App']` ([think-user-deploy.ts L50-L62][v-shim], [L102-L125][v-bindings]). So the same `App`-class bundle can leave the platform as a normal Worker. Preview facet data isn't copied (inferred).

#### 3.3 Trade-offs against serving from our platform

| | Dynamic Workers from our platform | WfP | Normal Workers on our account |
| --- | --- | --- | --- |
| Extra cost | None until about 1,000 unique workers a month (§2) | $25/month | None |
| Cloudflare API token held by the platform | None. "You run it without invoking the Cloudflare API at all" ([facets blog][facets-blog]) | Account-wide Workers Scripts Write | Same, and it can overwrite any Worker on the organisation's account (inferred) |
| Survives a platform deploy | No. DO restart, sockets drop | Yes | Yes |
| App storage | Facet SQLite inside our DO, so ADR-0004 holds | Real DO namespace or KV/D1 per app | Same as WfP |
| Static assets | Ours to serve from SQLite | Workers Static Assets | Workers Static Assets |
| Cron and queues for app code | Host-driven only | Dispatch Worker only | Native |
| Logs | Our tail handler | Workers Logs, Logpush | Workers Logs |
| Account clutter and limits | None | Separate namespace | Counts toward the 500 Workers on the shared organisation account |
| Matches what the app runs as in production | Close, not identical | Yes | Yes |

My reading is to start on Dynamic Workers for both Preview and Deployment. Keep vibesdk's shim approach as the exit to WfP if Deployments need to survive platform deploys, run cron, or serve heavy traffic (inferred).

### 4. URLs and isolation

#### 4.1 TLS, routes and DNS

- **Universal SSL covers only the apex and first-level names.** "coverage is limited to the root domain… and first-level subdomains." "Deeper subdomains, such as `dev.www.example.com`… are **not** covered" ([limitations][ussl-lim], updated 2026-10-09).
- **Deeper wildcards need ACM.** "Wildcard certificates only cover one subdomain level", so `*.platform.<domain>` needs its own advanced certificate ([ACM][acm], updated 2026-08-14). ACM is $10/month per zone ([Sandbox production guide][sandbox-prod], updated 2026-10-12). Total TLS also requires ACM ([Total TLS][total-tls]).
- **Other certificate routes are closed or narrow.** Custom certificates are Business or Enterprise only ([custom certificates][custom-certs]). A subdomain zone setup is Enterprise only ([subdomain setup][subdomain-setup]).
- **Workers Custom Domains get free per-hostname certificates.** "Creating a Custom Domain will also generate an Advanced Certificate on your target zone for your target hostname. This includes multi-level subdomains such as realms.app.example.com", and "no separate Advanced Certificate Manager subscription is required". But "Custom Domains do not support wildcard DNS records" ([custom domains][custom-domains], updated 2026-09-29). The limit is 100 per zone ([Workers limits][wl]).
  - This could give each Deployment a free `<app>.platform.<domain>`. The cost is an API token in the platform and a 100-hostname cap (inferred).
- **Routes.** "If a route pattern hostname begins with `*`, then it matches the host and all subhosts." Infix wildcards aren't allowed ([routes][routes], updated 2026-06-01).
- **DNS.** "Customers on all plans can create and proxy wildcard DNS records." "Wildcards are only supported on the first label" ([wildcard DNS][wild-dns]). So `*.platform` works but `*-platform` does not.
- **workers.dev is no help.** It "does not support wildcard subdomains" ([Sandbox production guide][sandbox-prod]).

#### 4.2 Cloudflare Access on app hostnames

- **Wildcards match one level.** "A wildcard in the Subdomain field only matches that specific subdomain level." `*.test.example.com` covers `alpha.test.example.com` but not `test.example.com`. Partial labels like `*test.example.com` work ([application paths][acc-paths], updated 2026-04-17). Limits are 500 applications per account and 50 domains per application ([account limits][acc-limits]).
- **Cookies are per app and per domain.**
  - The per-app token "is stored as a cookie on the protected domain". The global token is stored "at your team domain" ([authorization cookie][acc-cookie], updated 2026-08-03).
  - The `Domain` attribute isn't documented. Community reports say the cookie is host-only. That is unverified, so check it in DevTools.
  - SameSite is "Admin choice (Default: None)". Strict "can result in too many redirects".
  - The page contradicts itself on whether HttpOnly is on by default.
  - The optional binding cookie "is stripped at Cloudflare's network and never forwarded to the origin server", which blocks replay of a stolen `CF_Authorization`.
  - "Wildcarded subdomains… cannot receive preemptive cookies."
- **Tokens are per application.** "Cloudflare Access assigns a unique AUD tag to each application", and the `aud` claim "specifies which application the JWT is valid for" ([validate JWT][acc-jwt]).
  - If apps sat inside the platform's own Access application, an app would receive a token the platform accepts (inferred). Separate applications plus an AUD check on the platform remove that.
- **Signing in once covers every application.** The global session "provides single sign-on (SSO) functionality for all Access applications" ([session management][acc-session]).
- **Overlapping applications.** For paths, "the more specific rule takes precedence" ([application paths][acc-paths]). I found nothing on overlapping hostname applications, for example a Bypass on `*-preview.<apps-domain>` inside an Allow on `*.<apps-domain>`.
- **Worker-level Access is ruled out.** It still fails WebSocket upgrades with a 403 ([Workers + Access][wacc], updated 2026-10-12).

#### 4.3 Risks of agent-written apps on subdomains of our domain

- **Cookie tossing.** "An application on a subdomain can set a cookie with the `Domain` attribute, which gives access to that cookie on all other subdomains… This mechanism can be abused in a session fixation attack" ([MDN cookies][mdn-cookies]). RFC 6265 §8.6 says "Cookies do not provide integrity guarantees for sibling domains" ([RFC 6265][rfc6265]).
  - With apps at `<app>.platform.<domain>`, an app's JavaScript can set cookies for `platform.<domain>` and for `<domain>`, which every other site on that domain then receives (inferred).
  - A tossed `CF_Authorization` could sign the Developer into the platform as someone else (inferred).
- **Same-site is not same-origin.** A site is the registrable domain ([MDN site][mdn-site]). SameSite "protects you from requests from a different site, not a different origin", and "if you rely on same-site protection, you have to trust all your site's subdomains" ([MDN CSRF][mdn-csrf]).
  - Lax and Strict cookies still go with requests from a sibling app. That includes a WebSocket opened to the platform, which CORS doesn't cover. So the platform must check `Origin` or `Sec-Fetch-Site` (inferred).
  - `CF_Authorization` defaults to `SameSite=None`, so `Origin` checks matter on any layout.
- **Host-only cookies protect the platform's own sessions.** `__Host-` cookies "are only sent to the host that set them" and defend against fixation ([MDN cookies][mdn-cookies]). We can't rename `CF_Authorization`, though.
- **The Public Suffix List is not practical for us.** It would make subdomains cross-site, but its maintainers decline "private-use, sandbox, test, lab, beta" requests and small projects, and updates propagate slowly ([PSL guidelines][psl-guidelines]).
- **Precedent.**
  - GitHub moved Pages to github.io because "it was possible to write (but not read) github.com domain cookies" ([GitHub blog][gh-pages-blog], 2013).
  - Google serves risky content from `*.googleusercontent.com` so it poses "virtually no threat… to google.com authentication cookies" ([Google security blog][google-content], 2012). web.dev recommends a separate domain, ideally on the PSL ([securely hosting user data][webdev-userdata]).
  - Cloudflare's `workers.dev` and `pages.dev` are on the PSL ([public_suffix_list.dat][psl-dat]).
- **Layout summary (inferred).**
  - `<app>.platform.<domain>` and `<app>-platform.<domain>` are both same-site with the platform and with all of `<domain>`.
  - A separate registrable domain is cross-site to both. Apps on it are still same-site with each other, which matters less because they all belong to our Developers.

#### 4.4 Path-based previews such as `/preview/<id>/`

- **On the platform origin, the app owns the platform.** Its JavaScript runs as the platform, so it can call platform APIs with the Developer's cookies and read `localStorage`, which is per origin ([MDN localStorage][mdn-localstorage]) (inferred).
  - A `Service-Worker-Allowed: /` header from the app would let it register a service worker over the whole origin ([MDN service worker register][mdn-sw]). vibesdk strips `Service-Worker-Allowed`, `Service-Worker-Navigation-Preload` and `Clear-Site-Data` for this reason ([preview-headers.ts][v-headers]).
- **Mitigations.** The `Content-Security-Policy: sandbox` response header gives an opaque origin even when the URL is opened directly ([MDN CSP sandbox][mdn-csp-sandbox]). For iframes, don't combine `allow-scripts` with `allow-same-origin` ([MDN iframe][mdn-iframe]). An opaque origin still sends `SameSite=None` cookies, so CSRF checks are still needed (inferred).
- **Absolute URLs break.** vibesdk strips the prefix before forwarding ([L834-L856][v-basepath]). It rewrites root-relative `src`, `href` and `action` in HTML with `HTMLRewriter`, and root-relative `Location` headers ([L873-L904][v-rewrite]). But "**JS-side fetches and dynamic imports are NOT rewritten**" ([SKILL.md L16][v-skill]).
  - So `fetch("/api")`, CSS `url(/…)`, `new WebSocket("/ws")` and a client router's `location.pathname` all break without a Vite `base` and a router `basename` (inferred).
  - A subdomain per app avoids all of this.

#### 4.5 How vibesdk and Cloudflare OS do it

- **vibesdk.**
  - **Hosts.** Previews are path-based at `/space/<id>/preview/<branch>/` on a separate preview host. If `CUSTOM_PREVIEW_DOMAIN` is set, previews return 404 on the main domain ([worker/index.ts L272-L290][v-domains]). Production uses `build.cloudflare.dev` and a route `*build-preview.cloudflare.dev/*` ([wrangler.jsonc L206-L216][v-routes]).
  - **The wildcard is for deployed apps.** WfP apps get `<script>.build-preview.cloudflare.dev` ([urls.ts L93-L97][v-urls-wfp]). That second-level name is why its README asks for "wildcard DNS and Advanced Certificate Manager when required by your subdomain layout" ([README L82-L88][v-readme]).
  - **Auth.** A 30-minute HS256 JWT with `{spaceName, branch, userId, previewVersion, purpose}` arrives as `?t=` and is exchanged for an `HttpOnly` cookie scoped to the preview path. On a separate preview domain the cookie is `SameSite=None; Secure; Partitioned` ([spacePreviewToken.ts][v-cookie], [space-preview.ts L124-L175][v-auth]). It is revoked by bumping `previewVersion`. There is no Access.
  - **Isolation.** It sets no CSP. The IDE iframe uses `allow-scripts allow-same-origin` ([preview-iframe.tsx L338-L339][v-iframe]).
- **Cloudflare OS.**
  - **No URLs per gadget.** One hostname, one Custom Domain and no wildcards ([router][o-router], [starter deployment.jsonc][o-st-deploy]). A gadget has no HTTP surface.
  - **UI isolation.** Its UI is a single `client.js` in a `srcdoc` iframe with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`, which is an opaque origin. The iframe CSP sets `connect-src 'none'` ([GadgetUI.tsx L505-L519][o-iframe], [L105-L116][o-csp]).
  - **Server calls.** The iframe reaches its server through a postMessage port, then Cap'n Web over the workspace's `/api` WebSocket, then the facet.
  - **Auth.** Access sits on the one hostname. `/api` requires `Origin === url.origin` and a valid Access JWT ([server.ts L935-L953][o-origin]).
  - So it avoids the URL problem by not giving gadgets URLs. That doesn't fit apps that are real web apps with routes.

### 5. Security of running agent-written code

- **Isolation layers.**
  - V8 isolates with patches deployed "within hours — faster than Chrome itself", a "custom second-layer sandbox with dynamic cordoning of tenants based on risk assessments", MPK hardware isolation and "novel defenses against Spectre" ([blog][dw-blog]).
  - The general Workers model adds a second layer that "uses Linux namespaces and seccomp to prohibit all access to the filesystem and network", plus cordons ([security model][secmodel], updated 2026-09-18). Neither page describes Dynamic Workers separately.
- **Secrets stay with the host.** "a Dynamic Worker can only access what you explicitly give it", and props stay invisible to it ([bindings][dw-bind]). A facet's SQLite is separate from the supervisor's ([facets][dw-facets]).
  - So platform secrets, the Anthropic key and Workspace files are out of reach unless we put them in `env` or expose them through an entrypoint (inferred).
- **Network is open by default.** Without `globalOutbound`, the app inherits the platform's internet access (§1.6). With `null`, both `fetch()` and `connect()` throw.
- **Resource abuse.** CPU and subrequests can be capped. Memory can't, but the isolate limit applies (§1.2). An infinite loop or memory blow-up ends with `exceededCpu` or `exceededMemory` in the tail (inferred).
- **Browser side.** Agent-written front-end code runs in the Developer's browser. The isolation that counts there is the origin (§4.3, §4.4). A separate apps domain plus stripping Access headers and cookies before forwarding keeps the platform's session out of reach (inferred).

## Open questions

1. Do WebSocket upgrades and the Hibernation API work through `facet.fetch()` in production? vibesdk relies on it, and no doc says so.
2. Can a facet set an alarm? If not, scheduled work in apps has to be driven by the host.
3. Is `CF_Authorization` host-only, and is it HttpOnly by default? Check both in DevTools.
4. Does an Access-protected Preview load inside an iframe on the platform page in Edge and Chrome? If not, use the signed-token pattern, which needs preview hosts outside the Access application. How Access resolves overlapping hostname applications is undocumented.
5. How does the "1,000 per month" allowance combine with "the count resets daily"? Watch `distinctDynamicWorkerCount` in GraphQL after the first month.
6. Can the organisation register a separate domain for app content? This is a decision for the organisation. Without one, the fallback is ACM plus the same-site risks.
7. Who may open a Deployment: only its Developer, an identity-provider group, or anyone? This sets the Access policy, and whether Deployments need Access at all.
8. How late do tail events arrive for long-lived WebSocket requests, and does the Agent need streaming logs? Streaming tails are experimental today.
9. Does Preview latency stay acceptable if facets stay in the Workspace DO during a Check? If yes, the separate host DO in step 1 of the recommended setup isn't needed.

[agents-sha]: https://github.com/cloudflare/agents/tree/7945da9c6e142119e296984fc9caadec41e182a5
[vibe-sha]: https://github.com/cloudflare/vibesdk/tree/9da158d82c597a0e8f4bf033cdccd1053fb6fb15
[cfos-sha]: https://github.com/cloudflare/cloudflare-os/tree/8001c4b0c22dace6ffc67446d739fa7861aee1ea
[cfos-st-sha]: https://github.com/cloudflare/cloudflare-os-starter/tree/3d211477ad009e13a98d863d843e5c12a29ad02b
[workerd-sha]: https://github.com/cloudflare/workerd/tree/9cdf38052e165bdbb013f6e9c18bc63ad2228384
[workerd-wl-h]: https://github.com/cloudflare/workerd/blob/9cdf38052e165bdbb013f6e9c18bc63ad2228384/src/workerd/api/worker-loader.h
[workerd-wl-cc]: https://github.com/cloudflare/workerd/blob/9cdf38052e165bdbb013f6e9c18bc63ad2228384/src/workerd/api/worker-loader.c%2B%2B
[dw]: https://developers.cloudflare.com/dynamic-workers/
[dw-api]: https://developers.cloudflare.com/dynamic-workers/api-reference/
[dw-bind]: https://developers.cloudflare.com/dynamic-workers/usage/bindings/
[dw-facets]: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
[dw-obs]: https://developers.cloudflare.com/dynamic-workers/usage/observability/
[dw-egress]: https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
[dw-assets]: https://developers.cloudflare.com/dynamic-workers/usage/static-assets/
[dw-ulimits]: https://developers.cloudflare.com/dynamic-workers/usage/limits/
[dw-plimits]: https://developers.cloudflare.com/dynamic-workers/platform/limits/
[dw-price]: https://developers.cloudflare.com/dynamic-workers/pricing/
[dw-wf]: https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/
[dw-cl]: https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/
[dw-blog]: https://blog.cloudflare.com/dynamic-workers/
[facets-blog]: https://blog.cloudflare.com/durable-object-facets-dynamic-workers/
[dwf-blog]: https://blog.cloudflare.com/dynamic-workflows/
[tail]: https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/
[compat]: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
[secmodel]: https://developers.cloudflare.com/workers/reference/security-model/
[wl]: https://developers.cloudflare.com/workers/platform/limits/
[ra-enterprise]: https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-vibe-coding-platform/
[wfp-price]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/
[wfp-limits]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/
[wfp-how]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
[wfp-dispatch]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/
[wfp-outbound]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
[wfp-bind]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
[wfp-assets]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/
[wfp-host]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/
[wfp-obs]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/
[wfp-upload-api]: https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/
[saas-plans]: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
[scripts-api]: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
[mp-meta]: https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
[direct-upload]: https://developers.cloudflare.com/workers/static-assets/direct-upload/
[versions]: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/
[version-urls]: https://developers.cloudflare.com/workers/configuration/previews/
[beta-api-cl]: https://developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/
[domains-api]: https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
[perms]: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
[api-limits]: https://developers.cloudflare.com/fundamentals/api/reference/limits/
[ussl-lim]: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
[acm]: https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
[total-tls]: https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
[custom-certs]: https://developers.cloudflare.com/ssl/edge-certificates/custom-certificates/
[subdomain-setup]: https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/
[custom-domains]: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
[routes]: https://developers.cloudflare.com/workers/configuration/routing/routes/
[wild-dns]: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/
[sandbox-prod]: https://developers.cloudflare.com/sandbox/guides/production-deployment/
[acc-paths]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
[acc-cookie]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
[acc-jwt]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
[acc-session]: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
[acc-limits]: https://developers.cloudflare.com/cloudflare-one/account-limits/
[wacc]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
[mdn-cookies]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies
[mdn-site]: https://developer.mozilla.org/en-US/docs/Glossary/Site
[mdn-csrf]: https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/CSRF
[mdn-localstorage]: https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
[mdn-sw]: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register
[mdn-csp-sandbox]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox
[mdn-iframe]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
[rfc6265]: https://www.rfc-editor.org/rfc/rfc6265.html#section-8.6
[psl-guidelines]: https://github.com/publicsuffix/list/wiki/Guidelines
[psl-dat]: https://publicsuffix.org/list/public_suffix_list.dat
[gh-pages-blog]: https://github.blog/2013-04-05-new-github-pages-domain-github-io/
[google-content]: https://security.googleblog.com/2012/08/content-hosting-for-modern-web.html
[webdev-userdata]: https://web.dev/articles/securely-hosting-user-data
[wb-readme]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md
[wb-assets]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md#L181-L355
[wb-facet]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/packages/worker-bundler/README.md#L366-L425
[pg-fwd]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/examples/dynamic-workers-playground/src/server.ts#L74-L100
[pg-load]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/examples/dynamic-workers-playground/src/server.ts#L217-L252
[pg-log]: https://github.com/cloudflare/agents/blob/7945da9c6e142119e296984fc9caadec41e182a5/examples/dynamic-workers-playground/src/logging.ts#L149-L195
[v-split]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L675-L695
[v-ws]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L646-L665
[v-skill-ws]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L166-L198
[v-skill]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/skills/app-file-structure/SKILL.md#L16
[v-reset]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L809-L824
[v-onedo]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/deploy-engine.ts#L172-L176
[v-abort]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L741-L744
[v-loader]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L745-L760
[v-schema]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L133-L147
[v-persist]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/deploy-engine.ts#L129-L141
[v-serve]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L703-L732
[v-cache]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L78-L87
[v-decide]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L675-L695
[v-basepath]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L834-L856
[v-rewrite]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/durable-object.ts#L873-L904
[v-headers]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/space/src/space/preview-headers.ts#L1-L38
[v-blogs]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/think/browser-logs-tool.ts#L57-L78
[v-capture]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/browser-capture/capture-core.ts#L30-L76
[v-prompt]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/core/behaviors/think.ts#L322-L327
[v-cookie]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/utils/spacePreviewToken.ts#L3-L87
[v-auth]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/api/handlers/space-preview.ts#L124-L175
[v-domains]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/index.ts#L272-L290
[v-routes]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/wrangler.jsonc#L206-L216
[v-urls-wfp]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/utils/urls.ts#L93-L97
[v-readme]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/README.md#L82-L88
[v-iframe]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/src/routes/chat/components/preview-iframe.tsx#L338-L339
[v-deploy-branch]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/core/behaviors/think.ts#L908-L912
[v-userdeploy]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/agents/core/behaviors/think.ts#L905-L987
[v-api]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/deployer/api/cloudflare-api.ts#L39-L173
[v-subdomain]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/deployer/api/cloudflare-api.ts#L297-L328
[v-oauth]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/oauth/cloudflare-connect.ts#L16-L39
[v-shim]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/deployer/think-user-deploy.ts#L50-L62
[v-bindings]: https://github.com/cloudflare/vibesdk/blob/9da158d82c597a0e8f4bf033cdccd1053fb6fb15/worker/services/deployer/think-user-deploy.ts#L102-L125
[o-id]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L4318-L4332
[o-loader]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L4353-L4379
[o-bump]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L5683-L5699
[o-env]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L2403-L2430
[o-tail]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/overseer.ts#L10162-L10247
[o-agent-637]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/agent.ts#L637
[o-sched]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/gatekeeper-scheduler/README.md#L81-L91
[o-router]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/router/src/index.ts#L24-L49
[o-iframe]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-frontend/src/GadgetUI.tsx#L505-L519
[o-csp]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-frontend/src/GadgetUI.tsx#L105-L116
[o-origin]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/packages/workshop-backend/src/server.ts#L935-L953
[o-readme-ea]: https://github.com/cloudflare/cloudflare-os/blob/8001c4b0c22dace6ffc67446d739fa7861aee1ea/README.md#L44-L48
[o-st-deploy]: https://github.com/cloudflare/cloudflare-os-starter/blob/3d211477ad009e13a98d863d843e5c12a29ad02b/deployment.jsonc#L18-L25
[o-st-obs]: https://github.com/cloudflare/cloudflare-os-starter/blob/3d211477ad009e13a98d863d843e5c12a29ad02b/docs/observability.md#L119
