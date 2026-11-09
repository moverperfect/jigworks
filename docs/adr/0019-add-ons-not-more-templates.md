# Add-ons, not more Templates

Most apps people ask for need more than either Template gives: a sign-up sheet has to remember names, a rota needs an organiser who can change it, and a booking page should email the owner. The Agent wrote that groundwork from scratch in every app, which made the first Turn slow (100 to 119 s in #67's live check) and every app's storage slightly different. More Templates wouldn't fix it, because an app's abilities combine and Templates don't: a rota with an organiser's area that sends emails would need a Template of its own. So, from spec #88:

- **Two Templates.** Worker + React, the default, for anything with a page, and Worker for something with none, such as a webhook.
- **Abilities are add-ons.** An add-on is a tested set of files and notes that gives an app one ability. Each lives in `addons/<id>/`, beside the Templates: its files, its notes for the Workspace's `AGENTS.md`, and `addon.json`, which gives its name, its description, when it fits, the add-ons it needs, its Packages at exact versions, the Secrets it needs with the reason to give the Developer, and the edits that join it to an app. `pnpm generate` packs them with the Templates.
- **The default Template is built from the storage add-on.** At pack time, `worker-react` is the React Template with storage's files and notes added, and its own files already make storage's joining edits. So the store's code exists once, and a new app that needs to remember things starts with it working.
- **The platform doesn't merge add-ons into files the Agent may have changed.** An add-on writes only files of its own. The edits that join it to an app, such as a binding in `wrangler.jsonc` or an export from the Worker, are the Agent's to make in the app as it stands.
- **Abilities that need platform work come first as platform tickets, not add-ons:** scheduled reminders, which need cron or alarms, and live updates, which need WebSockets into an app's Durable Objects. Apps have neither (ADR 0015).

## Considered options

- **A Template for each combination,** such as a sign-up sheet with an organiser's area. The combinations multiply, and each copy of the shared code drifts.
- **Merging an add-on into the app's files,** such as adding its binding to `wrangler.jsonc` for the Agent. The Agent may have changed any of those files, and a merge that guesses wrong breaks the app. The Agent reads the files as they stand and makes the edits reliably.
- **Storage over SQL,** as a table in each Durable Object's SQLite. The store keeps its records in the object's key-value storage instead, which a SQLite-backed Durable Object also keeps in its SQLite. A Workspace's tests run in a Dynamic Worker (ADR 0017), which can't construct a Durable Object or reach SQLite, but can run the store's code over a key-value stand-in kept in memory. So the store's tests test the store, and the app's own tests can use the same stand-in.

## Consequences

- **Workspaces made before keep their own files.** A Template is copied into a Workspace when the app starts, so changing one changes no app already made.
- **An add-on's notes go under a heading that names it,** such as `## Storage (add-on \`storage\`)`, which also records that the app has it.
- **Packing fails, saying what to fix,** when a manifest names a missing add-on or a Package without an exact version, when an add-on and its Template, or two add-ons, write the same file, or when an add-on needs itself.
- **A Template can't yet be built from an add-on with Packages.** Packing refuses one, rather than leave the Template's `package.json` without them.
- **Add-on files have fixed paths,** under `src/server/`, in apps from either Template. The Worker Template's Worker imports them from `./server/`. An add-on for the front end, such as `live`, puts its files under `src/client/`, and fits only apps that have one.
- **Live updates came first as an add-on after all,** `live`, in which a page asks one of the app's routes for changes every few seconds (#108). It works without WebSockets, at the cost of a request per page every few seconds; WebSockets into apps are researched in #109.
- **The store suits small apps:** its collections live in one Durable Object instance, and filtering and sorting are done in code over the whole list. Changes that must happen together are methods on that one instance, whose calls run one at a time.
