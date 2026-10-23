# 11: App data in Durable Objects

**Parent:** [spec](../spec.md), user stories 58 and 59 (stage 5)

**What to build:** An app declares a Durable Object binding in its `wrangler.jsonc` and stores data through it, in both the Preview and the Deployment. The two never see each other's data.

**Blocked by:** 08 (Preview the latest Build).

**Status:** ready-for-agent

- [ ] A Durable Object binding declared in `wrangler.jsonc` appears in the app's `env`, and the app reaches instances by name. The platform runs each instance as a facet inside the app host (ADR 0006).
- [ ] Preview data and Deployment data are kept apart.
- [ ] Preview data survives a new Build, and Deployment data survives a new publish.
- [ ] A `wrangler.jsonc` that declares KV, D1, R2, queues or cron triggers fails the Build with an error saying they aren't supported.

## Tasks

1. Durable Object binding backed by facets.
2. Keep Preview and Deployment data apart, and keep data across new Builds and publishes.
3. Build error for unsupported bindings and triggers.

Drafted by an AI agent on Jack's behalf.
