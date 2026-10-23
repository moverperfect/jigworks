# 22: Hosted SaaS: grilling session and spec

**Parent:** [spec](../spec.md)

**What to build:** A grilling session with Jack, then a spec and tickets for the hosted SaaS: one Jigworks that serves many organisations from `app.jigworks.dev`. This ticket makes sure that work happens. The decisions already made on 2026-10-23 are the starting point:
- one repository, with code only the hosted SaaS uses in a directory of its own;
- Better Auth for sign-in on the hosted SaaS, with Access kept for Installations, both behind one identity module;
- custom domains for Deployments through Cloudflare for SaaS, one per Deployment at first.

**Blocked by:** 13 (Tests in isolates).

**Status:** needs-triage

- [ ] The session decides each of these:
  - who pays for the Agent's model usage: metered by Jigworks, or each customer's own Anthropic key;
  - billing, plans and prices;
  - abuse controls on the apps domain, covering anonymous sign-ups, unrestricted outbound access and the risk of Safe Browsing flagging the whole domain;
  - where Better Auth keeps its data: Drizzle on a Durable Object, or D1;
  - where customer data lives, and GDPR;
  - whether ADR 0006 (Dynamic Workers rather than Workers for Platforms) still holds at scale;
  - organisations as a core idea: who owns a Workspace, and who may open a Deployment;
  - custom domains, including sign-in on a customer's hostname;
  - putting the apps domain on the Public Suffix List, given that its maintainers turn down small projects (`docs/research/run-and-host.md`, §4.3), and what to do if it's refused;
  - a private package for anti-abuse rules;
  - a contributor licence agreement, if outside contributions are wanted.
- [ ] The outcome is a spec and tickets, plus ADRs for the decisions that are hard to reverse.

## Tasks

1. A grilling session with Jack.
2. Write the spec.
3. Break it into tickets.

Drafted by an AI agent on Jack's behalf.
