# Jigworks

A browser-based platform where a Developer and the Agent build and host Cloudflare Workers apps entirely in Workers isolates. The spec is issue #23, and its sub-issues are the tickets. Before working on an area, read `GLOSSARY.md` and the ADRs in `docs/adr/` that touch it. `docs/findings.md` holds each stage's verdict and measurements.

## How Jack wants the work done

- **One ticket at a time:** the lowest-numbered open `ready-for-agent` issue whose blockers are all closed. Use subagents for parallel or bulky work.
- **Each ticket** gets a branch and a pull request that says `Closes #N`. Commit to the branch as you go. Jack merges.
- **Before a pull request is ready:**
  1. Run the `code-review` skill for Standards and Spec, plus a third subagent for Lean: what could be removed or simplified.
  2. Get Codex's second opinion, as a tracked background task that takes about 10 minutes: `codex exec -o .wrangler/codex-NN.md review --base main < /dev/null`.
  3. Check every finding against the code. Fix the real ones, giving each fix a test that fails without it, and run Codex again after large fixes.
  4. Comment on the issue with the date: what was built, what was fixed, and what wasn't changed and why.
- **Deploys:** every merge to `main` deploys once the tests pass. After a deploy, do a live check from Jack's signed-in browser, put the measurements in `docs/findings.md`, and add a dated comment to the issue.
- **Before live model runs,** state a usage budget.
- **Dependencies** are exact versions published at least a day ago.
- **Words:** use the glossary's words in code, UI text and docs, in British English.
- **Organisation-neutral:** the repo, its commits, issues and pull requests name no particular organisation, its hostnames or its people's work addresses. Values for one Installation live in its configuration; docs may use Jack's Installation (`app.jigworks.dev`, `jigworks.app`) as the example.
- **Cloudflare:** work only in Jack's own account.
- **Notes:** keep durable notes in `docs/development.md` or in issue comments. Jack has Claude Code's memory turned off.

## Development

Read `docs/development.md` before running, testing or deploying the platform, before a live check, and before upgrading Think, the Agents SDK, the AI SDK, worker-bundler or the vitest plugin.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `moverperfect/jigworks`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
