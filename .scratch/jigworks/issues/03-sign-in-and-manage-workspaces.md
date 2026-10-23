# 03: Sign in and manage Workspaces

**Parent:** [spec](../spec.md), user stories 11 to 15 (stage 2)

**What to build:** The Developer signs in at the platform's hostname through Access. The home page lists their Workspaces. From there they can create a Workspace from the Worker Template, export one as a zip, or delete one by typing its name.

**Blocked by:** 02 (Probe).

**Status:** resolved

- [x] The platform refuses requests without a valid token for its own Access application, and requests from any email other than the configured Developer's.
- [x] The platform refuses API calls and WebSocket upgrades whose `Origin` isn't the platform's.
- [x] The home page lists the Developer's Workspaces. The list is kept in the Developer's own Durable Object.
- [x] Creating a Workspace from the Worker Template gives it these files:
  - a Hono app;
  - `wrangler.jsonc`, listing `nodejs_compat`;
  - `tsconfig.json`;
  - a generated `worker-configuration.d.ts`;
  - `package.json`, with exact versions and `"packageManager": "pnpm@…"`;
  - `AGENTS.md`.
- [x] Each Workspace has its own Durable Object, which later also holds its Conversation. Its files go through our own interface in front of Cloudflare's file store.
- [x] The zip export contains the Workspace's files only: no Packages and nothing under `/attachments/`.
- [x] Deleting a Workspace requires typing its name. It removes the Workspace from the list and deletes its data.
- [x] Tests at the platform's HTTP interface cover all of the above.

## Tasks

1. Request gate for the platform: the Access token and `Origin` checks.
2. Developer directory.
3. Workspace Durable Object, with the file store interface.
4. Worker Template.
5. Create, list and delete Workspaces.
6. Zip export.
7. Home page.
8. Platform Access application, plus DNS records and the certificate for the platform's hostname (Jack). The agent deploys after asking.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-14, agent:** Built and tested locally; not deployed yet.

- **Request gate (`src/gate`):**
  - Checks the platform Access app's token and the Developer allowlist (`DEVELOPER_EMAILS`).
  - Requires the platform's `Origin` on every change and every WebSocket upgrade, refuses any request whose `Origin` is another one, and refuses any request a browser marks with a `Sec-Fetch-Site` other than `same-origin` or `none`.
  - Service tokens are refused.
  - `wrangler dev` signs in as `DEV_SIGNED_IN_AS` from `.dev.vars`, for localhost requests only.
- **Storage:** the Developer directory and the Workspace are SQLite-backed Durable Objects. The Workspace is already a Think Durable Object (0.20.2), with its files in the file store Think's tools use (`@cloudflare/shell` 0.4.3), behind the `Files` interface in `src/files`. Reads query the store's table synchronously and decode base64 rows. Writes go through the store. Deleting uses the Agents SDK's `destroy()`, and the API accepts the reset that can cut off its reply. See `docs/research/think-file-store.md`.
- **API:** `/api/me`, `/api/templates`, and `/api/workspaces` (list, create, get, delete, export). Zip exports are built with fflate.
- **App and Template:** the home page is a React + Vite app in `client/`. The Worker Template is in `templates/worker`, packed by `templates/pack.mjs`.
- **Tests:** 23 tests at the HTTP seam sign Access tokens with a test key, whose public half the test config serves in place of Access's. One adapter test, `test/files.test.ts`, checks how `src/files` reads Think's store, base64 and binary files included.
- **Tried in a browser** against `wrangler dev`: create, list and delete with the typed-name dialog all work.

**2026-10-14, agent:** Reviewed before commit, with three Claude reviewers (standards, spec, lean) and Codex as a second opinion. I checked each finding against the code before acting on it.

- **Fixed:**
  - The zip export corrupted binary files, because everything was decoded as text.
  - A delete could return 500 after the data had gone, because the Agents SDK resets the object.
  - A failed create left an unlisted Workspace. It's now listed first, and removed again if filling it fails.
  - A Workspace created while the home page's list was loading could vanish until a reload.
  - Reads from an app's page are now refused through `Sec-Fetch-Site`.
  - One test reached into Think's store through the HTTP tests. It's now an adapter test.
  - The test that deleting removes the files now really checks them.
  - The generated types depended on a local `.dev.vars`.
  - The Template's `AGENTS.md` lacked the CSS and image rule.
  - Glossary words were misused in comments, and the name rule was duplicated between the API and the pages; it's now in `src/shared`.
- **Deleted:** the home page's mock API, which had drifted from the real one. Local work uses `wrangler dev` with `.dev.vars`.
- **Kept on purpose:**
  - The `DEV_SIGNED_IN_AS` bypass, which works for localhost only and is empty in `wrangler.jsonc`.
  - A comma-separated Developer list, which the tests need for two Developers.
  - `agents` 0.28.0 and `ai` 7.0.138, older than the research's versions, because those were less than a day old.
- **Moved to ticket 06:** the request gate covers only `/api/*`. The Agents SDK's WebSocket route must go through it too.

**2026-10-14, agent:** Deployed, with the platform's hostname as a Workers Custom Domain. Worker startup time is 130 ms.

- **Public DNS** (Cloudflare Foundation DNS) resolves the name to Cloudflare. Requests to `/` and `/api/me` there redirect to the platform's Access sign-in, and the certificate is valid.

**2026-10-22, agent:** Checked live from Jack's signed-in browser.

- Jack signed in through Access, and the home page showed Jack's email after "Signed in as".
- From the live page:
  - creating gave 201 and getting gave 200;
  - the zip export gave 200, `application/zip`, 119 KB, named after the Workspace;
  - deleting with the wrong name gave 400, and with the right name 204;
  - the deleted Workspace left the list.
