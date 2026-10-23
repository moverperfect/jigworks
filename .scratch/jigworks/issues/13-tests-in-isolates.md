# 13: Tests in isolates

**Parent:** [spec](../spec.md), user stories 66 to 70 (stage 6)

**What to build:** The Agent writes vitest-style tests and runs them with a `test` tool. Tests also run at the end of every Turn. The results show in the problems list, but failing tests don't force the Agent to retry.

**Blocked by:** 07 (Build on demand, on save and at the end of each Turn), and 09 (Worker + React Template with Tailwind) for the React criterion.

**Status:** ready-for-agent

- [ ] The runner is built from vitest's own parts and runs in a Dynamic Worker, which returns results over RPC.
- [ ] It supports `describe`, `it`, `expect`, `vi.fn`, `vi.spyOn` and fake timers.
- [ ] `vi.mock` and snapshots fail with a clear "not supported" message.
- [ ] The `test` tool runs the Workspace's test files and returns which passed and failed, and why.
- [ ] Tests run at the end of every Turn, after the Check and the Build. Results appear in the problems list, and failures don't use up retries.
- [ ] A Hono app's routes can be tested end to end. A React app's logic and server-rendered HTML can be tested.
- [ ] The findings document gets the stage 6 verdict and the experiment's overall conclusion.

## Tasks

1. vitest-compatible runner in a Dynamic Worker.
2. `test` tool.
3. Run tests at the end of each Turn, showing results without retries.
4. Write the stage 6 verdict and the overall conclusion.

Drafted by an AI agent on Jack's behalf.
