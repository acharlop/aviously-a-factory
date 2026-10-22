---
name: meeting
description: Route untriaged tickets, settle memo follow-ups, run lost and found, and get the calls a decision-needed ticket waits on, in rounds of numbered questions, each answer posted to the ticket. Use when asked to hold a meeting, triage, grill or decide tickets, go through the backlog, or get tickets ready for the factory.
---

# Meeting

A session for tickets that need someone's call. It ends with every ticket in scope on its next route, most often `ready-for-agent` for the factory.

A person answers every question here, so a meeting needs one present. When nobody is there, the factory takes the reversible calls itself and leaves the rest on `decision needed` for the next meeting. The one exception is step 2 run alone by the runner (below).

**Whose call.** Each question goes to whoever owns the decision: the person in the meeting, unless the ticket's assignee, the ticket itself or the project handbook names someone else for that sort of call. A question owned by someone absent goes on the ticket as a comment that @-mentions them, and the ticket keeps `decision needed`.

Read the project handbook first (`AGENTS.md` and `docs/agents/`): what it settles is not a question, and where it routes a sort of ticket or question its own way, it wins over this page.

## Routes

A ticket is triaged once it has exactly one of these:

| Label             | Means                                                                                                                                                                    | Next                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `ready-for-agent` | Scoped and decided: one agent can build it end to end                                                                                                                    | The factory claims it                     |
| `decision needed` | An open question blocks it: options listed, the ticket says to decide together, a comment leaves a question open, or a money, data, legal or schema call nobody has made | A meeting                                 |
| `ready-for-human` | Needs credentials, an account, a console or hands on a device                                                                                                            | A person                                  |
| `to-discuss`      | The team talks it through before anyone builds                                                                                                                           | The water cooler                          |
| `blocked`         | Waits on someone or something outside the repo, named in a comment                                                                                                       | Lost and found; then re-route             |
| `Parked`          | Not now, by choice                                                                                                                                                       | Lost and found, until someone picks it up |

A ticket that waits on another ticket is routed as usual and gets a GitHub `blocked_by` edge to it. `kind:*`, `department:*`, `recall`, `p1` and `p3` sit beside the route; `epic` and `odd jobs` tickets are never routed.

## Which version runs

`.factory/resolved.json` (`pnpm factory resolve` writes it) says how this project runs the triage and reality-check steps, under `steps`: an `agent` to spawn as `aviously-a-factory:<agent>`, a `local` step to follow instead, or `none` to skip it.

## 1. Route

List the untriaged tickets with `pnpm factory untriaged`. For a long list the triage step's agent takes the first pass; check its calls as below. Read each with its comments (`gh issue view <n> --comments`): a later comment may already have decided it. Give it the one route whose "Means" fits, its `kind:` label and its department, and one going to `ready-for-agent` its priority (step 8). A `blocked` ticket gets a comment naming who or what it waits on; a `Parked` one gets one line why.

A ticket that fixes or undoes something the factory shipped ("found after #N") also gets `recall`.

Comment one line on why when the route isn't obvious from the ticket.

## 2. Memos

Every meeting. Memos are the open issues labelled `paperTrail.memoLabel` in the `paperTrail.repo` that `.factory/resolved.json` names; with `paperTrail: "none"` there are none, so skip this step. Bring each open memo's unticked follow-ups as a round: accept, change or drop each. Tick what is accepted and comment a change or a drop on the memo. Accepted lines on one theme in the same files are filed as one ticket with a box each (3 at most), labelled `p3` unless the answer raises it. End each box's line with `→ <ticket link>`, or a dropped one's with `→ <link to the comment>`: the File step closes a past day's memo once every box is settled that way. Calls made stand unless someone comments; raise one only when it looks wrong.

**Run alone, unattended.** The runner's memos step runs only this step, with no person present, on the memos it names: ticks and comments there are already a person's answers. A comment asking for a change, a ticked follow-up, or a line left unticked once its memo is closed becomes a follow-up ticket as above, with a reply on the memo linking it. Skip what a reply on the memo already answers. Ask nothing, route nothing else, and claim or build nothing.

## 3. Lost and found

Run the `lost-and-found` skill. Its questions join this meeting's rounds.

## 4. Read fresh

Before the first round, and again before each round after it:

```bash
git fetch origin && git log --oneline HEAD..origin/<base>
gh issue view <n> --comments
gh pr view <pr> --comments   # each related PR; <base> is gate.base in .factory/resolved.json
```

Teammates answer on the ticket, often mid-meeting. A question asked without their latest comment gets reopened.

## 5. Facts first

Find what the code, the data and the docs already say before asking anything: interns or `Explore` agents, in parallel. A question the code can answer is not a question. Skip what the project handbook or an ADR already settles.

## 6. Rounds

A few numbered questions per round, each with its options, a recommendation and one line why. Give a short pro/con table when the trade-off needs one; give no walkthroughs. Enough to answer in one line ("all recommended", "3 b"). Ask the next round once this one is answered.

While one ticket is grilled, the factory can build one that is already decided.

## 7. Post each decision

As each answer lands, before any temp starts, comment it on the ticket:

```markdown
**Decided:** <the choice>. <One line why.>
```

A decision that sets a rule also goes into the project handbook or a new ADR with the ticket's PR.

## 8. Priority

`p1` (matters now), normal (no label) or `p3` (polish and follow-up nits) rank the factory's intake. Every ticket going to `ready-for-agent` gets one, asked in a round with a recommendation: `p1` for what a user or the decision's owner is waiting on, `p3` for a nit, normal otherwise. Once a meeting, list the open `ready-for-agent` tickets with their level (`gh issue list --label ready-for-agent --limit 200 --json number,title,createdAt,labels`) and bring a round on any that look misranked, such as an old ticket that now matters or a `p1` nothing waits on any more.

## 9. Route on

When a ticket has no open question left, swap `decision needed` for the route that now fits. Before a swap to `ready-for-agent`, run the reality check on it (Which version runs): put its corrections in the body, bring a premise that changes what to build as a question in the next round, and comment `Reality check at <sha>`. Ask its priority in the same round. A UI ticket going to `ready-for-agent` names its reference screen; one too big for one agent splits into tickets under its epic.

Done when every ticket in scope has exactly one route, each one on `ready-for-agent` has its priority call, each decision on it is a comment, every open memo line is ticked or answered, and lost and found is done.
