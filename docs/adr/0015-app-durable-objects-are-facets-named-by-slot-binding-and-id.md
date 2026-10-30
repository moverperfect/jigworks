# An app's Durable Objects are facets named by slot, binding and ID

ADR 0006 gives apps Durable Objects and nothing else, run as facets inside the Workspace's app host. A Dynamic Worker can't be given a real Durable Object namespace, so the platform provides a stand-in.

- **The binding.** The Build reads `durable_objects.bindings` from `wrangler.jsonc`. The app host loads the app through a module of its own, which puts a stand-in for each binding in `env`, for the app's default export and for the classes the bindings name. The stand-in has `idFromName`, `getByName`, `get`, `newUniqueId` and `idFromString`. Its stubs send `fetch` and RPC calls to an entrypoint in the platform, `AppData`, which passes them to the app host.
- **The instance.** The app host runs each instance as a facet named `<slot>:<binding>:<id>`, where the slot is `preview` or `deployment`. So the Preview's data and the Deployment's never meet, and each instance has its own SQLite database.
- **New code.** When the Preview gets a new Build, or the Deployment a new publish, the app host aborts that slot's facets. The next call starts them with the new class, and their storage stays.

## Consequences

- **Data follows the binding's name and the instance's ID,** not the class. Renaming a binding starts it afresh; changing its class keeps its data.
- **Publishing doesn't copy data.** The Deployment's instances keep their own, and the Preview's stay with the Preview.
- **The Build fails on what the platform doesn't have:** KV, D1, R2, queues, cron triggers, a binding to another Worker's class, and a class the app doesn't export.
- **Every call makes extra hops,** from the app to `AppData`, then to the app host, then to the facet. Arguments and results must be values that can be copied.
- **The app host keeps the name of every facet it starts,** so it can abort them for new code and delete them with the Workspace. Cloudflare doesn't document whether `deleteAll()` reaches a facet's database.
- **Not supported:**
  - jurisdictions and location hints;
  - WebSockets into an instance;
  - alarms in an instance, which Cloudflare doesn't document for facets.
