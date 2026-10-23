# 20: Revisit ADR 0002: a language service in the editor

**Parent:** [spec](../spec.md), user story 18

**What to build:** A grilling session with Jack decides whether the editor gets a language service: hover, type-aware completions and go-to-definition. ADR 0002 ruled one out to keep the experiment's question about ts-rust clean. As a product, the missing language service is a gap that Developers will notice.

**Blocked by:** 13 (Tests in isolates), which ends the experiment.

**Status:** needs-triage

- [ ] The session weighs the options: TypeScript's JavaScript language service in the browser or in a Dynamic Worker, ts-rust if it gains one, or none. For each, it weighs the Worker's size, memory, how fast it feels and how much it costs to run.
- [ ] The outcome is a new ADR, or a note added to ADR 0002, and tickets if the work goes ahead.

## Tasks

1. Research the options.
2. A grilling session with Jack.
3. Write the ADR and any tickets.

Drafted by an AI agent on Jack's behalf.
