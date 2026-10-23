# 08: Preview the latest Build

**Parent:** [spec](../spec.md), user stories 42, 47 to 53, 63 and 64 (stage 4)

**What to build:** The latest good Build runs as the Preview at its own hostname on the Installation's apps domain (ADR 0012), and only its Developer can open it. The Workspace page shows it in a pane, with its server logs and front-end errors. The Agent can send the Preview requests and read its logs.

**Blocked by:** 07 (Build on demand, on save and at the end of each Turn) and 18 (Go public), so the Preview is built on Jack's own account.

**Status:** ready-for-agent

- [ ] Each Workspace has an app host, a second Durable Object that receives each new Build. When a Build fails, the Preview keeps the last good one.
- [ ] The Preview runs on a Dynamic Worker, keyed by its Build's hash, at `<slug>-<random>-preview.<apps domain>`. Jack's Installation's apps domain is `jigworks.app`.
- [ ] Only the owning Developer gets through. The apps' Access application has its own token, which the platform checks separately from its own.
- [ ] Access headers and the Access cookie are stripped before app code runs. Only `__Host-` cookies pass between the browser and app code, in both directions. Any other cookie an app sets is dropped, with a warning in its logs.
- [ ] Apps run with:
  - the compatibility date and flags from their `wrangler.jsonc`;
  - CPU and outgoing-request limits;
  - unrestricted outbound access.
- [ ] Server logs, and the front-end errors an injected script reports, go into a capped table in the app host.
- [ ] The Agent has `request_preview`, which sends a request and returns the response, and `preview_logs`, which reads server logs and front-end errors.
- [ ] The Workspace page has a Preview pane with its logs and an open-in-tab button.
- [ ] The pane is a cross-site frame (ADR 0012), so it gets in with a short-lived signed link. This ticket settles, and records in an ADR:
  - how Preview hostnames get past the apps' Access application, given that Access's handling of overlapping hostname applications is undocumented (`docs/research/run-and-host.md`, open question 4);
  - whether the pane keeps its sign-in in a partitioned cookie or a token in each URL.
- [ ] A manual check shows the pane loading the Preview in Chrome, Firefox and WebKit, Safari's engine.
- [ ] The Preview keeps answering while the Workspace runs a Check or a Build.

## Tasks

1. App host Durable Object that receives Builds.
2. Serve the Preview from a Dynamic Worker, keeping the last good Build.
3. Request gate for apps: the apps' Access token, the owner check, header stripping and the `__Host-` cookie filter.
4. Runtime settings and limits.
5. Server logs, plus the injected script that reports front-end errors.
6. `request_preview` and `preview_logs` tools.
7. Preview pane, with logs, an open-in-tab button and the signed link.
8. The Worker route for `*.<apps domain>/*` in `wrangler.jsonc`, which deploys with the platform. Ticket 17's wizard already set up the apps' Access application and the wildcard DNS record.

This is the largest ticket. Split it into two if it doesn't fit one session: tasks 1 to 4, then tasks 5 to 7.

Drafted by an AI agent on Jack's behalf.
