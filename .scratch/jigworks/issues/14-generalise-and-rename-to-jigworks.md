# 14: Generalise and rename to Jigworks

**Parent:** [spec](../spec.md). This starts the move from one organisation's experiment to Jigworks, a product any organisation can install.

**What to build:** Nothing in the repo is specific to one organisation or uses the old name, and the platform reads everything specific to one Installation from its configuration. The Developer list takes emails and `@domain` entries, and refuses everyone while it's empty.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] Nothing in the repo names a particular organisation, or its hostnames, Access team, AUD, identity provider set-up, internal DNS, people's work email addresses or machines. A grep over the repo, `node_modules` aside, finds none of them.
- [x] The product is called Jigworks everywhere: the package, the Worker (`jigworks`), the page title, the glossary, the spec, the ADRs and the docs. A grep for the old product names finds nothing.
- [x] `wrangler.jsonc` describes Jack's Installation at `app.jigworks.dev`. The Access team, the AUD and the Developer list stay empty until ticket 17 fills them, so the gate refuses every request until then.
- [x] The Developer list (`DEVELOPER_LIST`) is comma-separated emails and `@domain` entries, matched without regard to case:
  - `@example.com` lets in `a@example.com`, but not `a@sub.example.com` or `a@example.com.evil`;
  - an empty list refuses every request, so a too-open Access policy can't let strangers in;
  - tests cover each case.
- [x] The glossary is titled Jigworks and has:
  - **Installation:** one copy of Jigworks running on an organisation's Cloudflare account;
  - **Operator:** the person who sets up and runs an Installation;
  - a Developer who is someone on the Installation's Developer list;
  - a Deployment that anyone the Installation's apps Access application lets in can open.
- [x] Docs about the product (the spec, ADRs, glossary, research and findings) name roles, such as the Operator, not people. Tickets and the handover may still name Jack.
- [x] The findings keep every measurement, but not the hostnames, Worker version IDs or account they were taken on.
- [x] ADR 0004 keeps Durable Objects as the only storage, now because that's the fewest products an Operator has to set up. An R2 Package cache stays the first thing to move (ticket 19).
- [x] The probe is gone: `probe/`, its scripts, its vitest project, and its parts of `generate`, `types` and `typecheck`. The findings keep its numbers, without the links to its raw results.
- [x] Tests generate the Access signing key when they start, and `test/fixtures/access-test-key.json` is deleted, so no private key is ever committed.
- [x] The handover's commands work on Linux, and it describes the way of working agreed on 2026-10-23.
- [x] The feature directory is `.scratch/jigworks/`.
- [x] `pnpm typecheck`, `pnpm --filter client typecheck`, `pnpm --filter client build` and `pnpm test` pass.

## Tasks

1. The Developer list, with `@domain` entries, refusing everyone when empty.
2. Rename to Jigworks.
3. Make configuration, code, tests, docs and tickets organisation-neutral.
4. Glossary: Installation, Operator, and the new wording for Developer and Deployment.
5. Delete the probe.
6. Generate the test signing key at test time.
7. Linux commands and the new way of working in the handover.
8. The grep that proves nothing is left.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-23, agent:** Done locally. The first commit comes in ticket 16, and there's nothing to deploy until ticket 17.

- **The Developer list:**
  - `DEVELOPER_LIST` takes emails and `@domain` entries (`src/gate/index.ts`). `DEVELOPERS` was taken by the Developer Durable Object namespace.
  - `@team.example` matches that domain only, never a subdomain or a longer name. An empty list refuses everyone.
  - The `@domain` tests go through `/api/me` and fail against the old exact-match code. The empty list is tested on the gate itself, because the tests' Worker runs with one list.
- **Rename:**
  - Worker `jigworks`, package `jigworks`, page title Jigworks, feature directory `.scratch/jigworks/`.
  - `wrangler.jsonc` points at `app.jigworks.dev`, with the Access team, AUD and Developer list empty until ticket 17.
- **The probe:** deleted, with its vitest project and its parts of `generate`, `types`, `typecheck`, `.gitignore` and `.gitattributes`.
- **The test signing key:** `vitest.config.ts` makes a new key pair on every run and passes the private half to the tests as a binding. `test/fixtures/access-test-key.json` is gone.
- **Docs:**
  - The glossary has Installation and Operator.
  - ADR 0004 has its new reason.
  - ADR 0008, the spec, the research, the findings and tickets 01–13 are organisation-neutral. The findings keep every measurement, without hostnames or version IDs.
  - The handover has Linux commands and the way of working agreed today.
- **Tests:** 130 pass in about 40 s on Linux. The typecheck and the client build pass. A grep for the earlier organisation, its hostnames, people and machines, and the old product names finds nothing.
- **Reviews:** Standards, Spec and Lean subagents, plus Codex. Codex found nothing.
- **Fixed:**
  - a dead `includes("@")` check in the gate, and a comment that it made wrong;
  - the email being lowercased twice;
  - `GateConfig.developers` renamed `developerList`;
  - an empty-list test that would also have passed on a 401;
  - the key IDs and the JSON round trip in the test key;
  - a `pkill` pattern for the tail that also matched the shell running it;
  - an Avoid word ("deployment") and "chatting" in the handover and glossary;
  - two pronouns for third parties in the research;
  - the probe written of in the present tense;
  - a repeated block in the ts-rust build README.
- **Not changed:**
  - `test/gate.test.ts` calls the gate directly, against the HTTP-seam rule. An empty Developer list can't be configured beside a full one in one test Worker, and `test/access.test.ts` already tests `verifyAccess` directly the same way.
  - Ticket 03's history still says `DEVELOPER_EMAILS`. It was the name when that ticket was done.
  - `docs/research/cloudflare-platform.md` keeps its Entra ID notes, because they're general Cloudflare facts. It also keeps some words the glossary avoids, because it predates the glossary.
  - `vendor/ts-rust-wasm/bin/tsc-wasm.js` is now executable. pnpm sets that on install, so it will be committed that way.
  - The spec no longer says deploys need asking first, because Jack decided on 2026-10-23 that merges to `main` deploy.
