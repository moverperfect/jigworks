# 16: Move to GitHub

**Parent:** [spec](../spec.md)

**What to build:** The repo is on GitHub as the private `moverperfect/jigworks`. Its history starts with one organisation-neutral commit, and the tickets are GitHub issues with matching numbers. From here on, each ticket is a branch and a pull request, and CI checks every pull request.

**Blocked by:** 14 (Generalise and rename to Jigworks) and 15 (Apps on their own domain).

**Status:** ready-for-agent

- [ ] Tickets 14 and 15 go through the review pass and Codex, compared against the files as they arrived. The comparison uses a local baseline commit that is never pushed.
- [ ] The baseline is then thrown away. The first commit on `main` holds the reviewed files and says they were imported from `ae7a5a0`. Ticket 14's grep finds nothing in it.
- [ ] `moverperfect/jigworks` is private, with `main` as its default branch.
- [ ] Tickets 01 to 22 become issues #1 to #22, in order, before any pull request exists:
  - resolved tickets are imported closed, with their comments;
  - the spec is imported last, as the parent issue, with every ticket as a sub-issue.
- [ ] There's a label for each of the five triage roles, and every issue carries its ticket's status.
- [ ] `.scratch/` is gone, and `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md` describe GitHub Issues.
- [ ] A GitHub Actions workflow runs `pnpm typecheck`, the client's typecheck and build, and `pnpm test` on every pull request, with the repo's pinned Node and pnpm versions.
- [ ] vitest 5 is tried on Linux. If `@cloudflare/vitest-plugin` works under it, the pin moves. If not, the handover records why it stays.
- [ ] The handover describes the branch and pull-request workflow, and says a pull request merges only when Jack says so.

## Tasks

1. Review 14 and 15 against the baseline, then start the history afresh.
2. Create the repository and push `main`.
3. Import the tickets and the spec as issues, with labels.
4. Remove `.scratch/` and rewrite the issue-tracker docs.
5. CI for pull requests.
6. Try vitest 5.

Drafted by an AI agent on Jack's behalf.
