---
name: handbook
description: The factory handbook, the rules every temp and foreman follows in every project. Read it before building, writing a commit, PR, ticket or comment, or merging. The project's own handbook (AGENTS.md, docs/agents) adds to it and names its exceptions.
---

# The factory handbook

Rules for every temp and foreman, in every project. The project handbook (AGENTS.md and `docs/agents/`) wins where it names an exception.

## Merging

- Every merge is a squash merge: `gh pr merge --squash --delete-branch`. Never a merge commit, never a rebase merge, unless the project handbook names another method.
- Never `gh pr merge --admin`. Let the merge queue land it; a by-hand merge is run by a person.

## Gates and hooks

- Fix and verify locally first (the project's checks, and a dev run where the change warrants it), then push once as a batch. Don't push every commit to CI.
- Git hooks always run. Never `--no-verify`, `git commit -n` or a `core.hooksPath` override. A hook that can't pass is a stop condition: report it.
- Delete scratch and probe files before committing. If a gate trips on one, remove the file; never loosen the gate.
- When an unrelated failure surfaces, say so in one line and carry on. Don't investigate it unless asked.

## Code

- Don't keep anything just because it was there. Delete vestigial paths, flags and config you touch.
- Comments: one line, and only when the code can't say it: a non-obvious why, a trap, a load-bearing ordering. Never restate the line. More than a line belongs in the ticket or PR body.
- GitHub Actions: pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment, never a tag. Where the project has Dependabot, its github-actions group updates the pins.

## PR and ticket refs

Never a bare `#123`. Always a full link with an icon after the number:

- Pull request: `[#123 🔀](https://github.com/OWNER/REPO/pull/123)`
- Issue, ticket or epic: `[#123 📋](https://github.com/OWNER/REPO/issues/123)`

`OWNER/REPO` is where the item lives (`gh pr view <n> --json url`, `gh issue view <n> --json url`). Not sure which kind or which repo? Check with `gh`; if still unsure, write "PR 123 in <repo>" in words. This covers tickets, PR bodies and comments, commit bodies, memos and docs.

## Writing for people

Tickets, PR bodies, comments, review comments, commit bodies, memos and docs:

- The top half is blunt: a short title and a few lines saying what it is, what broke, what to do. No filler, no hedging. Never paragraphs.
- Everything else goes below in `<details><summary>For AI</summary>`: mechanism, file paths, reasoning, run lists, verification, alternatives.
- A person must be able to act on the top half alone, in seconds.

The plugin's hooks refuse a gh write whose refs carry the wrong icon, a hook bypass and an admin merge. They guard agents that follow the rules; they are not a sandbox.
