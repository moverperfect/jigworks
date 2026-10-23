# 19: Stage 7: R2 as a shared Package cache

**Parent:** [spec](../spec.md), user stories 22 to 28

**What to build:** A measurement of whether an R2 bucket shared by every Workspace makes Packages faster and smaller to keep. Today each Workspace downloads its own copy of every Package from npm into its Durable Object (ADR 0004). The likely design is R2 as a cache behind each Workspace's SQLite copy, because a Check reads hundreds of files and SQLite is in the same process.

**Blocked by:** 13 (Tests in isolates).

**Status:** ready-for-agent

- [ ] On Jack's account, these are measured with and without the R2 cache:
  - creating a Workspace from each Template;
  - adding a Package;
  - a Check;
  - storage per Workspace.
- [ ] The findings get a stage 7 verdict, with the measurements.
- [ ] If R2 wins, it becomes required for every Installation, so there's one code path. ADR 0004 is updated, and the wizard sets up the bucket.
- [ ] The one-day minimum age and the integrity checks still apply to everything that comes from the cache.

## Tasks

1. An R2 Package cache behind each Workspace's SQLite copy.
2. Measure both ways on the deployed Installation.
3. Write the stage 7 verdict, and update ADR 0004 if R2 wins.

Drafted by an AI agent on Jack's behalf.
