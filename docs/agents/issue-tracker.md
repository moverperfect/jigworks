# Issue tracker: GitHub Issues

Issues and specs for this repo live in GitHub Issues on `moverperfect/jigworks`. Use the `gh` CLI.

## Conventions

- One issue per ticket. A spec is a parent issue, and its tickets are its sub-issues.
- A ticket's number is its issue's number: "ticket 08" is #8. The spec for tickets 01 to 22 is #23.
- Triage state is a label (see `triage-labels.md`). A resolved ticket is a closed issue.
- A ticket's body starts with its spec (`**Parent:** #N`), then says what to build, what it's blocked by (`**Blocked by:** #N`), its acceptance criteria and its tasks.
- Comments and history are issue comments, each starting with its date and author: `**<YYYY-MM-DD>, agent:**`.
- A ticket's pull request says `Closes #N`.

## When a skill says "publish to the issue tracker"

Create an issue with `gh issue create -R moverperfect/jigworks`, with the label for its triage state. A spec's tickets are sub-issues of the spec:

```sh
id=$(gh api repos/moverperfect/jigworks/issues/<ticket> --jq .id)
gh api -X POST repos/moverperfect/jigworks/issues/<spec>/sub_issues -F sub_issue_id="$id"
```

## When a skill says "fetch the relevant ticket"

`gh issue view <number> -R moverperfect/jigworks --comments`. Jack will normally give the number.

## Wayfinding operations

Used by `/wayfinder`.

- **Map:** a parent issue whose body holds the Notes, Decisions so far and Fog.
- **Child ticket:** a sub-issue of the map, with the question in its body and a `Type:` line (`research`, `prototype`, `grilling` or `task`).
- **Blocking:** a `**Blocked by:** #N, #N` line near the top of the body. A ticket is unblocked when every issue it lists is closed.
- **Frontier:** open, unblocked sub-issues without the `claimed` label, lowest number first.
- **Claim:** add the `claimed` label (create it if it's missing) before any work.
- **Resolve:** comment the answer under an `## Answer` heading, close the issue, then add a pointer (gist and link) to the map's Decisions so far.
