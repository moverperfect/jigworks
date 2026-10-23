# 21: Install path for other Operators

**Parent:** [spec](../spec.md)

**What to build:** An Operator at another organisation, with a Cloudflare account and two domains, goes from a fresh copy of the repo to a working Installation without editing code. It grows out of ticket 17's wizard, and it must be done before the first outside organisation installs Jigworks.

**Blocked by:** 13 (Tests in isolates).

**Status:** ready-for-agent

- [ ] One wizard sets up an Installation: its hostnames, the apps domain, both Access applications, the Developer list and the Anthropic key.
- [ ] An Installation's settings live apart from the files that come from upstream, so updating to a new Jigworks version doesn't conflict with them.
- [ ] The same wizard checks a running Installation, and reports anything missing or wrong.
- [ ] An Operator guide explains what an Installation needs, what it costs on Cloudflare, and how to update it.
- [ ] A test run from a fresh clone on a second Cloudflare account ends with a working Installation.

## Tasks

1. Keep each Installation's settings apart from upstream files.
2. Grow the wizard into an install-and-check script.
3. The Operator guide.
4. A trial install on a second account.

Drafted by an AI agent on Jack's behalf.
