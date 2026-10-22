---
name: lost-and-found
description: Revisit the blocked, ready-for-human and Parked tickets nothing else comes back to, or every ticket assigned to you, and keep, re-route or close each, in rounds of numbered questions. Use when asked for lost and found, to clean up or review open tickets that aren't ready-for-agent, or the tickets assigned to you.
---

# Lost and found

For tickets no other session comes back to: `blocked`, `ready-for-human` and `Parked` (the `meeting` skill, Routes). Untriaged and `decision needed` tickets belong to the meeting, and `to-discuss` ones to the water cooler.

A person answers every round, so lost and found needs one present. A meeting runs it as its step 3.

Invoked as `/lost-and-found [<ticket>... | <label> | mine]`. With nothing named, it takes all three labels, least recently updated first:

```bash
gh issue list --search 'is:open label:blocked,ready-for-human,Parked sort:updated-asc' --json number,title,labels,updatedAt
```

`mine` takes every open ticket assigned to you, whatever its label, except the factory's claims (`in-progress`):

```bash
gh issue list --search 'is:open assignee:@me -label:in-progress sort:updated-asc' --json number,title,labels,updatedAt
```

## 1. Check each

Read it with its comments (`gh issue view <n> --comments`), and what it points at: the blocker, linked PRs (`gh pr list --search "<n>" --state all`), and main (`git log origin/<base> --oneline -E --grep '#<n>([^0-9]|$)'`, `<base>` being `gate.base` in `.factory/resolved.json`).

- **`blocked`:** is what it waits on still open? A blocker that resolved means re-route.
- **`ready-for-human`:** was it done by hand, or did it go stale? Has the code since made it moot (`Explore` agents, in parallel, for the ones in question)?
- **`Parked`:** does the one line why still hold, or has something since made it now?
- **Assigned to you (`mine`):** are you still the one doing it? A `ready-for-agent` ticket with an assignee is never free for the factory, so unassign it unless you are building it yourself. A `to-discuss` or `decision needed` ticket goes to the water cooler or a meeting; name it in the round rather than settle it here.

## 2. Rounds

A ticket with nothing new stays, without a question: list those in one line. Bring each other ticket as a numbered question with keep, re-route (to which label), unassign or close, a recommendation and one line why. Enough to answer in one line ("all recommended", "3 close").

## 3. Act

As each answer lands, comment one line why on the ticket, then swap its label, unassign it, or close it (`gh issue close <n> --reason completed` when done, `--reason "not planned"` otherwise). A ticket going to `ready-for-agent` needs what the meeting asks of it (its step 9, Route on); when it doesn't have that yet, it goes to `decision needed` instead.

Done when every ticket in scope was kept, re-routed, unassigned or closed, and each change has its comment.
