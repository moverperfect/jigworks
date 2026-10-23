# 12: App secrets

**Parent:** [spec](../spec.md), user stories 60 to 62 (stage 5)

**What to build:** The Developer gives a Workspace secrets on a screen in the platform, and the app reads them from `env` in both its Preview and its Deployment. The Agent knows the secrets' names but never their values.

**Blocked by:** 10 (Publish a Deployment) and 11 (App data in Durable Objects), because this ticket carries the stage 5 verdict.

**Status:** ready-for-agent

- [ ] The Developer can add, replace and remove a Workspace's secrets. Values are never shown again after saving.
- [ ] Apps read the secrets from `env` in the Preview and the Deployment.
- [ ] The Agent can list the secrets' names, and nothing gives it their values.
- [ ] No platform secret ever reaches app code.
- [ ] The findings document gets the stage 5 verdict, covering Deployments, app data and secrets.

## Tasks

1. Per-Workspace secrets in `env`, with names only for the Agent.
2. Screen for managing secrets.
3. Write the stage 5 verdict.

Drafted by an AI agent on Jack's behalf.
