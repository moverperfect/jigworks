# 17: Move to Jack's Cloudflare account

**Parent:** [spec](../spec.md)

**What to build:** Jack's Installation runs on Jack's own Cloudflare account at `app.jigworks.dev`, behind Jack's own Access. Every merge to `main` deploys it once the tests pass. A wizard script walks the Operator through the steps only they can do.

**Blocked by:** 16 (Move to GitHub).

**Status:** ready-for-agent

- [ ] A wizard script, written with the `wizard` skill, walks the Operator through each step and checks it worked where it can:
  1. a trademark search for "Jigworks" in the UK and the US;
  2. Workers Paid;
  3. buying `jigworks.dev` and `jigworks.app` through Cloudflare Registrar;
  4. a Zero Trust team;
  5. the platform's Access application on `app.jigworks.dev`, with its cookie set to `SameSite=Lax` (ADR 0012);
  6. the apps' Access application on `*.jigworks.app`, with the wildcard DNS record, both used from ticket 08;
  7. `wrangler login`;
  8. the Anthropic key, as a Worker secret;
  9. a Cloudflare API token limited to Workers, as the GitHub secret for deploys.
- [ ] No secret passes through the agent.
- [ ] The values the wizard collects go into `wrangler.jsonc`: the team domain, the AUDs and the Developer list.
- [ ] `app.jigworks.dev` is a Workers Custom Domain of the `jigworks` Worker.
- [ ] A GitHub Actions workflow deploys on every push to `main`, but only after the typecheck, the client build and the tests pass. It runs `pnpm generate`, builds the client and runs `wrangler deploy`.
- [ ] After the first deploy, a live check from Jack's signed-in browser creates a Workspace, runs a Check, a Turn and a Build, and puts the numbers in the findings beside the earlier ones. A usage budget is stated before the Turn.
- [ ] The handover describes deploys from `main`.

## Tasks

1. The wizard script (Jack runs it).
2. Fill `wrangler.jsonc` from what the wizard collected.
3. The deploy workflow.
4. The first deploy and the live check.

Drafted by an AI agent on Jack's behalf.
