# 15: Apps on their own domain

**Parent:** [spec](../spec.md), user stories 50, 56, 57, 64 and 65

**What to build:** A new ADR 0012 records that apps live on a registered domain of their own, set by the Operator: `jigworks.app` for Jack's Installation. It replaces ADR 0008. The spec and tickets 08 to 13 are rewritten to match.

**Blocked by:** 14 (Generalise and rename to Jigworks).

**Status:** resolved

- [x] ADR 0012 says:
  - apps live on a domain of their own, which the Operator sets in the configuration;
  - Universal SSL's free wildcard certificate covers it, so no Advanced Certificate Manager is needed;
  - hostnames use the first label only: `<slug>-<random>.<apps domain>` for a Deployment and `<slug>-<random>-preview.<apps domain>` for its Preview;
  - the platform keeps the `__Host-`-only cookie filter, because every app is still the same site as every other app, and the `Origin` and `Sec-Fetch-Site` checks, because Access's cookie is `SameSite=None` unless the Operator chooses otherwise;
  - the apps domain goes on the Public Suffix List when the hosted SaaS launches (ticket 22).
- [x] ADR 0008 says ADR 0012 replaced it.
- [x] The spec and tickets 08 to 13 use the apps domain and the Installation's two Access applications. Nothing in them depends on Advanced Certificate Manager, split DNS or one identity provider.
- [x] Ticket 08 is blocked by 18, so the Preview is built on Jack's own account.
- [x] `docs/research/run-and-host.md` says ADR 0012 took its recommendation.

## Tasks

1. Write ADR 0012, and mark ADR 0008 as replaced.
2. Rewrite the spec and tickets 08 to 13 for the apps domain.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-23, agent:** Done locally, for ticket 16's first commit.

- **ADR 0012:**
  - An Installation's apps live on a registered domain of their own, set by the Operator. It must be its own zone, not a subdomain.
  - Universal SSL covers it, and hostnames use the first label only.
  - The `__Host-` cookie filter stays, because apps are the same site as each other. The `Origin` and `Sec-Fetch-Site` checks stay, because Access's cookie is `SameSite=None` unless the Operator sets Lax. Ticket 17's wizard now sets Lax.
  - The Public Suffix List waits for ticket 22.
- **ADR 0008** says 0012 replaced it.
- **The spec and tickets 08–13** use `<apps domain>`. Nothing in them needs Advanced Certificate Manager, split DNS or one identity provider.
  - Ticket 08 is blocked by 18.
  - Ticket 08's Worker route deploys with the platform, and ticket 17's wizard already sets up the apps' Access application and DNS.
- **Glossary:** "Apps domain" is a new term. The Deployment wording is "anyone the apps' Access application lets in", as everywhere else.
- **Found in review, and now in ticket 08:**
  - The Preview pane becomes a cross-site frame, so browsers that block or partition third-party cookies won't send the apps' Access cookie into it.
  - A signed link only works on a hostname that Access doesn't intercept, and how Access resolves overlapping hostname applications is undocumented.
  - Ticket 08 now settles how Preview hostnames get past Access, and how the pane keeps its sign-in, and records the answer in an ADR. Its browser check names WebKit, because Safari can't run on Linux.
- **Reviews:** Standards and Spec subagents, plus Codex over tickets 14 and 15 together. Codex found nothing.
- **Fixed:**
  - ADR 0012 and the gate's comment claimed `SameSite` already protects the platform;
  - the spec still called the signed link a fallback;
  - a wrong section reference to the research;
  - "every other app then receives it", which is now "browsers then send it";
  - an Avoid word ("session");
  - two names for the apps' Access application;
  - Jack's hostnames in the spec's platform bullet;
  - the same-site note in the research that predated ADR 0012.
- **Not changed:**
  - ADR 0012 and ticket 08 still name `app.jigworks.dev` and `jigworks.app` as Jack's Installation. The ticket asked for that, and the handover now says docs may use Jack's Installation as the example.
  - ADR 0012 keeps one "(inferred)", for the browsers' cookie behaviour, because nothing in the research sources it.
