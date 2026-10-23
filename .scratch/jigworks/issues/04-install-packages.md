# 04: Install Packages

**Parent:** [spec](../spec.md), user stories 22 to 28 (stage 2)

**What to build:** A new Workspace gets its Template's Packages installed. Any later change to `package.json` installs or removes Packages to match. The Workspace keeps the versions it resolved, out of sight, and the platform's API reports any version warnings. This ticket also provides the "add a Package by name" operation that the Agent's `add_package` tool uses in 06.

**Blocked by:** 03 (Sign in and manage Workspaces).

**Status:** resolved

- [x] Adding a Package by name, with an optional version range, picks the newest version that's at least a day old. It writes that exact version into `package.json` and installs it.
- [x] Versions published less than a day ago are never chosen, directly or indirectly.
- [x] A Package's own dependencies resolve once per change to `package.json`. The result is kept in the Workspace's Durable Object, not as a file, so the same files always give the same Packages.
- [x] Each Package has one version. A version listed in `package.json` wins; otherwise the newest version every requester accepts is used.
- [x] Each version conflict, and each peer dependency whose version doesn't fit, becomes a warning the API returns.
- [x] Only `.js`, `.mjs`, `.cjs`, `.d.ts`, `.d.mts`, `.d.cts`, `.css` and `.json` files are kept, and Packages built for a specific operating system or CPU are skipped.
- [x] Each Workspace keeps its own copies of its Packages.
- [x] Packages never appear in the file tree, the zip or the Workspace's files.
- [x] Tests use a fake registry that answers in npm's formats, never the live registry.

## Tasks

1. npm registry client with the one-day minimum age.
2. Resolver: one version per Package, the conflict rules and warnings.
3. Download, filter and store Packages in the Workspace.
4. Install when a Workspace is created and whenever `package.json` changes.
5. A fake registry for tests.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-22, agent:** Built, reviewed and checked against the real npm registry. Not deployed yet.

- **Modules:** `src/packages`:
  - `registry.ts`, the npm registry client;
  - `publish-times.ts`, which streams publish times out of the full document;
  - `resolve.ts`, the resolver;
  - `tarball.ts`, which downloads, checks integrity, unpacks and filters;
  - `index.ts`, which stores Packages in the Workspace's SQLite.
- **Publish times:** npm's compact document has none, and the full one can be tens of megabytes: 3.2 MB compact for `react-dom`, 8.7 MB for `typescript`, and more for full. So publish times are read only when a Package's document changed in the last day, by streaming the full document and keeping only its `time` object (about 107 ms for 21 MB). A version with no publish time counts as too new.
- **Resolver:**
  - It walks the graph from `package.json` round by round until the choices settle, and warns if they don't settle within 20 rounds.
  - Peers are installed like any other requirement.
  - Optional Packages built for one system are skipped quietly. A required one gets a warning.
  - Tag ranges such as `latest` are accepted. `npm:` aliases, git and URLs are warnings.
- **Limits:**
  - 32 MB per tarball and 64 MB unpacked.
  - 1.9 MB per file (ADR 0004's row limit).
  - A 30-second timeout on registry documents and 60 seconds on tarballs.
  - A tarball without an integrity value is refused.
- **API:**
  - `GET` and `POST /api/workspaces/:id/packages`.
  - `PUT /api/workspaces/:id/files/<path>`, the first piece of ticket 05's file API. Saving `package.json` through it reinstalls.
  - Adding a Package and saving `package.json` take turns, so neither overwrites the other.
- **Beyond the ticket:** adding takes `dev`, and `@types/` Packages go in devDependencies by default. `pnpm platform:dev` now passes `--local-upstream localhost`, because the custom domain made `wrangler dev` treat local requests as coming from the platform's hostname.
- **Tests:**
  - 21 at the HTTP seam, against a fake registry (`test/fixtures`). It's synthetic, rather than recorded npm responses as first planned, so every case is deterministic.
  - Unit tests for the tarball reader and the publish-time streamer.
- **Real registry:** checked under `wrangler dev` against the real npm registry:
  - a new Workspace installs `hono` in 350–450 ms;
  - adding `zod`, `react`, `react-dom`, `@types/react` and `@types/react-dom` took 0.3–1.7 s each, with no warnings;
  - the versions chosen were all at least a day old (React 19.3.1, from 14 October; the canary builds published yesterday were rightly skipped).
- **Reviewed:** by three Claude reviewers (standards, spec, lean) and Codex as a second opinion.
  - **Fixed:**
    - versions with no publish time slipped past the one-day rule;
    - an unsettled resolver gave no warning;
    - a save and an add could overwrite each other;
    - one unreadable range dropped a Package for everyone;
    - tag requirements were missing from conflict warnings;
    - `"dependencies": null` crashed with a 500;
    - tarballs were buffered without a size cap;
    - a tarball without an integrity value was accepted;
    - documents were fetched twice per add;
    - "release" (a glossary word to avoid) was renamed "publish".
  - **Kept:** our own tar reader and installer, because worker-bundler's can't read PAX headers, have no one-day rule and check no integrity.
- **Moved to tickets 05 and 07:** Think's tools and bash will write `package.json` without going through the save above, so each Check and each Build installs first if the dependency fields changed.

**2026-10-22, agent:** Committed as `11235c8` and deployed (startup 121 ms). Checked live from Jack's signed-in browser:

- creating a Workspace took 2.4 s with `hono` installed, probably slower than the 0.4 s locally because it was the first request to a new isolate;
- adding `zod`, `react`, `react-dom`, `@types/react` and `@types/react-dom` took 0.5–1.8 s each, with no warnings;
- the same eight Packages and versions as locally were installed, and the test Workspace was deleted.
