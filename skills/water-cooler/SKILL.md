---
name: water-cooler
description: Go through the to-discuss tickets whose turn is yours, and on each either comment your view and leave it for the other person, or settle it and route it on. Use when asked to hold the water cooler or go through the to-discuss tickets.
---

# Water cooler

For `to-discuss` tickets: the team talks one through on the ticket before anyone builds. The talk is in comments, one person's turn at a time, so each pass leaves every ticket either waiting on someone else or decided.

A person writes every comment here, so the water cooler needs one present, and the factory never takes these tickets.

Invoked as `/water-cooler [<ticket>...]`. With none named, it takes every `to-discuss` ticket.

Read the project handbook first (`AGENTS.md` and `docs/agents/`): what it settles is not a point to discuss.

## 1. Pull

```bash
gh api user --jq .login
gh issue list --label to-discuss --json number,title,url,updatedAt --jq 'sort_by(.updatedAt)[]'
gh issue view <n> --json comments --jq '.comments[-1].author.login'   # each
```

A ticket is your turn when its latest comment isn't yours. Show two lists, linked: your turn, least recently updated first, and waiting, each with who it waits on. Waiting tickets are skipped unless named.

## 2. Read fresh

Before each ticket: `gh issue view <n> --comments`, and each related PR with `gh pr view <pr> --comments`. A teammate may have answered mid-session.

## 3. Facts first

Find what the code, the data and the docs already say: interns or `Explore` agents, in parallel. A point the code settles is not a point to discuss. Skip what the project handbook or an ADR already settles, and send a point the handbook routes elsewhere where it says.

## 4. Brief

One ticket at a time: what it is, where each person stands, what is still to settle, and your recommendation with one line why. Then ask: comment or settle.

## 5. Comment, or settle

- **Comment:** write the person's view as they put it, show it, and post it once they agree. The ticket keeps `to-discuss` and now waits on the other person.
- **Settle:** post the outcome, then swap `to-discuss` for the route that now fits (the `meeting` skill, Routes): `decision needed` while a question is open, otherwise the one whose "Means" fits. Rewrite the ticket body when the scope changed; split one too big for one agent into tickets under its epic.

```markdown
**Decided:** <what was agreed>. <One line why.>
```

A decision that sets a rule also goes into the project handbook or a new ADR with the ticket's PR.

Done when every ticket in scope that was your turn now waits on someone else or has left `to-discuss`.
