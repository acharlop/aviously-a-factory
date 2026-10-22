---
name: foreman
description: Run a shift - take the ready-for-agent tickets a filter admits, in an order, through claim, build, modules, quality control and rework into the merge queue, with temps and inspectors, supervised, unsupervised or lights-out, then file the paperwork. Use when asked to run the factory or a shift, build ready tickets or an epic, or pick up unfinished tickets.
---

# Foreman

You run one shift: you assign tickets, watch agents and decide when work is pushed. You build nothing yourself.

Invoked as `/aviously-a-factory:foreman [supervised|unsupervised|lights-out] [department:<name>]... [kind:<kind>]... [order:priority|fifo|lifo|alternate] [merged:<n>] [minutes:<n>] [in-flight:<n>] [<ticket>... | <epic>]`, supervised by default. **Read your mode in [modes.md](modes.md) now, before step 1**; it fills in every step below that says "your mode".

Read the project handbook first (`AGENTS.md` and `docs/agents/`) and the factory handbook (the `handbook` skill). Where the project handbook names an exception, it wins over this page.

## The shift

| Knob      | From the invocation                                                 | Default                  |
| --------- | ------------------------------------------------------------------- | ------------------------ |
| Filter    | `department:<name>` and `kind:<kind>`, each repeatable              | every ticket             |
| Mode      | `supervised`, `unsupervised` or `lights-out`                        | supervised               |
| Order     | `order:priority`, `fifo`, `lifo` or `alternate`                     | priority                 |
| Ends when | `merged:<n>` merged, no free ticket and nothing in flight, or a cap | the cap is `TIMEOUT_RUN` |
| In flight | `in-flight:<n>` tickets building at once                            | 3                        |

Tickets or an epic named in the invocation replace the filter and the order: take those, in the order given. `minutes:<n>` caps the shift; without it the cap is `TIMEOUT_RUN` (machine config, Timeouts). At the cap less 20 minutes, claim nothing new: finish what is in flight as far as it goes, then file (step 10). A shift that finds nothing to take and nothing in flight files and ends at once.

## Settings

- **The project:** `.factory/resolved.json` (`pnpm factory resolve` writes it): `steps` (each step's version and agent, a `local` step, or `none`), `modules`, `foreman` (worktree `setup`, `security` paths, `migrations`) and `paperTrail`.
- **The machine:** `~/.factory/machine`, with `~/.factory/<project>/config` on top: `QUEUE=on` on a machine that runs the merge queue, `QUEUE_PEER`, `MOBILE_SIGNOFF=on` on the one with the simulator, and the timeouts. `~/.factory/<project>/state` holds `RUN_COUNT`, the shift number; your mode says who bumps it.
- **The run folder:** `$FACTORY_RUN_DIR` when the runner sets it, else `~/.factory/<project>/runs/<date>`. Pass it as `--run-dir` to every command that takes one. Quality control's reports, parks' patches, the memo input, `state.md` and `suggestions.md` go there.

Then `pnpm factory timings start run`.

**Which version runs.** For each step, `steps.<name>` says: an `agent` to spawn as `aviously-a-factory:<agent>`; a `local` step to follow instead (read its file and do what it says); or `none` to skip the step. The gate and the merge are the `gate` and `merge` steps, run by `pnpm factory queue` whatever their version (step 2); you never run the gate yourself.

## Timeouts

Minutes, from the machine config. `pnpm factory timings` prints each step and agent past its timeout, then the steps' medians; `pnpm factory usage` prints each agent's minutes and tokens.

| Key               | Default | Step                 | When it runs out                                                                            |
| ----------------- | ------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `TIMEOUT_CODER`   | 30      | build                | Stop the agent; `pnpm factory park <n> --reason <text>`; one memo line on what it was doing |
| `TIMEOUT_REVIEW`  | 15      | each inspector       | Same                                                                                        |
| `TIMEOUT_FIX`     | 25      | rework               | Same                                                                                        |
| `TIMEOUT_STRINGS` | 15      | copy desk            | Same                                                                                        |
| `TIMEOUT_QUEUE`   | 40      | `pnpm factory queue` | The queue stops itself                                                                      |
| `TIMEOUT_RUN`     | 150     | the whole shift      | The cap (The shift)                                                                         |

Pass each agent its timeout in the brief; a temp's also says "first commit by minute 20". An agent never stops itself. While agents build, keep `pnpm factory timings --watch` running as a background command (`timeout: 7200000`), started when you dispatch into an idle pipeline and again each time it exits while agents still build; stop it when the last agent hands back. It exits printing `OVERDUE <agent>` once one passes its timeout. An overdue agent with commits on its branch gets one continuation (`SendMessage`) with a narrowed brief: what's left, then stop. One with nothing committed, or overdue a second time at the same step, is stopped (`TaskStop`), `pnpm factory stop-e2e <its worktree>` stops what it left running, and its row applies.

## The state lives on GitHub

A shift can stop anywhere: a usage limit, a closed laptop. Its progress is what GitHub, git and the run folder show, so the next shift picks up from there and never from a chat. Each step leaves its output there, and a ticket resumes at the first step whose output is missing:

| Step            | Its output                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| claim           | assignee, `in-progress` and the latest "In progress on branch" comment            |
| build           | commits on the branch past main, and the PR body file in the worktree's git dir   |
| modules         | the copy desk's `copy:` and `i18n:` commits; the screenshots folder; device shots |
| quality control | `<run folder>/<n>-quality-control-<head>.md`, or "Reviewed at `<head>`"           |
| rework          | "Reviewed at `<head>`" on the ticket                                              |
| push            | the open PR, with auto-merge on or off                                            |

`pnpm factory in-flight --run-dir <dir>` lists this machine's claims, each with the step it resumes at; a module step is yours to check against the table. On stderr, a `stale:` claim's PR merged after the claim with none open: release it (`gh issue edit <n> --remove-assignee @me --remove-label in-progress`). An `elsewhere` claim belongs to another machine or is orphaned: leave it.

**Checkpoint.** At each hand-back, overwrite `state.md` in the run folder: `Repo: <owner/name>` first, then each ticket in flight and its step, the queue, what waits on a person, and what intake gives next. A snapshot, never a log. After a compaction, read it beside GitHub. A brief's ticket URL comes from `gh issue view <n> --json url`, never from memory. Step 10 deletes it.

## Steps

### 1. Resume

Carry each ticket `in-flight` lists to its next step before taking anything new.

### 2. Queue

`steps.merge` says which merge runs. **merge@2** (GitHub native): GitHub merges each PR with auto-merge on once the base's required checks pass; `FACTORY_RUN_DIR=<run folder> pnpm factory queue` is a short pass, on any machine, beside anything, that brings PRs behind the base up to date, drops the ones whose required check failed or that conflict, and says what merged. Run it at each hand-back while PRs have auto-merge on, and before step 10. Each PR it dropped gets its cause fixed and auto-merge back on, or a line under waits. The rest of this step is merge@1.

**merge@1** (the Mac queue): only on a machine with `QUEUE=on` and a `merge` step that isn't `none`; elsewhere the memo says "queued for <`QUEUE_PEER`>" for each PR with auto-merge on. The queue is `FACTORY_RUN_DIR=<run folder> pnpm factory queue`, in the background. It holds the machine's lock, so a second one waits, and waits out `QUEUE_PEER`'s. It never runs beside an agent's end-to-end tests: once 3 to 6 PRs have auto-merge on, or nothing else is left to build, dispatch nothing new, give the running agents up to 10 minutes to hand back, then run it. An agent still running tests at 10 minutes is stopped, `pnpm factory stop-e2e <its worktree>`, and its ticket resumes at its step next round. Start the next round when the queue ends. Each PR it dropped gets its cause fixed and auto-merge back on in that round, or a line under waits.

### 3. Claim (claim@1)

Take the tickets named, the epic's open sub-issues (`gh issue view <epic> --json subIssues`), or the next from `pnpm factory free [--department <name>]... [--kind <kind>]... [--order <order>]`, which prints its order first and then one `<number>\t<kind>\t<title>` a line. On the device machine a shift of the mobile module's department adds `--mobile` (the `modules` skill, Mobile). Among the tickets a round takes, start the UI ones first: they take screenshots and run longest. An odd jobs ticket builds its unticked boxes in one PR, which closes it.

Read each with its comments (`gh issue view <n> --comments`): comments carry the decisions. A comment that leaves a question open is an open question (below). A ticket with no `Reality check at` comment gets the reality check first (`steps.reality-check`), in the background, for the next tickets while the current ones build: put its corrections in the ticket body, comment `Reality check at <sha>: <k> corrections`, and send a premise that changes what to build to Open questions. A ticket back on `ready-for-agent` with a parked branch (`git branch -r --list 'origin/park/*'`) resumes on it: rename it back and carry it to its first missing step.

Plan the round: tickets that touch the same files go to one temp or one after another; a big rename or migration runs alone; a ticket that builds what others use goes first; a ticket that adds a guard over existing code (a lint rule, a check, a schema constraint) goes last and alone.

Then claim it, before any code: name the branch `<department>/<n>-<slug>` (its `department:` label, else its kind), run `pnpm factory claim <n> <branch>`, and on exit 1 (someone claimed it first) take the next. Add the worktree: `git worktree add ../<repo>-wt/<n>-<slug> -b <branch> origin/main`, then `foreman.setup` in it when the project sets one. Setups can run side by side; one killed for resources (exit 137, out of memory or disk) is retried once, alone; a second failure is a red for the memo and the ticket waits for the next shift.

### 4. Build (build@1)

A fresh temp (`steps.build`) in that worktree, described `<n> build`, with a lean brief (Agents). Leave out `isolation: "worktree"`: it would put the temp in a worktree of its own. A ticket that only rewords copy gets no temp: the copy desk makes the change (the `modules` skill).

### 5. Modules

Run the `modules` skill's steps for each module `modules` switches on: the copy desk after the build, screenshots re-taken after it, the device stage beside quality control. A module set to `"none"` is skipped.

### 6. Quality control (quality-control@1)

`pnpm factory inspectors` in the worktree lists the axes this branch gets, one `<axis>\t<agent>\t<why>` a line: spec and standards always, security when it touches a `foreman.security` path, looks when the screenshots module is on (skip it for a branch with no UI change, naming why). A branch that changed only the source catalog gets the spec axis alone, and its findings go to a copy desk rerun.

Start one inspector per axis, in the background, each described `<n> quality-control: <axis>`: the spec brief carries the ticket URL and the temp's `Fails without the fix` line; the standards brief, the temp's choices to check; the security brief, the `why` line; the looks brief, the shots folder and the reference screens. Once every axis is back, confirm each finding against the code. Write `<run folder>/<n>-quality-control-<first 12 of the head sha>.md`: its first line `Findings: <k>`, then each confirmed finding with the file:line and evidence its inspector gave. A temp's choice becomes a call only once every axis is back.

**Removals.** The spec inspector's `Removals:` line lists each removal with the ticket line that asks for it, or `unexplained`. Check each against the diff. Explained, it is a call: name it under calls. Unexplained, it is an open question, and the PR goes up without auto-merge until someone answers.

### 7. Rework (rework@1)

With findings, one fresh temp (`steps.rework`), described `<n> rework`, once per change: the confirmed findings, each with its file:line and evidence (a looks finding marked `needs a re-shot` goes as a try, its re-shot the check), plus small objective fixes in files the branch touches, each a call. The rest is filed as follow-ups (below). With nothing confirmed, no temp: your mode says who records "Reviewed at". Rework that added or reworded a source string doesn't push: the copy desk runs again first.

### 8. Push

`pnpm factory push <n> --auto-merge on|off [--shots <dir>]` in the worktree checks the claim again, pushes (the project's pre-push hook runs), opens the ready PR from the temp's body file or updates it, turns on auto-merge when told and records "Reviewed at". A rework temp briefed to push runs it; with nothing confirmed, you do. When, and with auto-merge on or off, is your mode's. Its stop is a stop condition: a lost claim is parked (`pnpm factory park <n> --reason "<who holds it>"`); a schema change it refuses goes to a `<n> push` temp, which merges main, generates the migration and runs it again. Your calls go in the PR body file before the push: one line on top, the detail under For AI.

### 9. Threads and merges

Answer every review thread on your open PRs: fix it and resolve the thread, or reply with why you disagree. A thread that changes the direction of the work is an open question. With the `reviewBots` module on, review bots' threads are among them and their verdict holds auto-merge (the `modules` skill). Once a PR merges, check its ticket closed, then `pnpm factory epic-close <n>` (it also takes `in-progress`, `ready-for-agent` and the assignee off) and `pnpm factory clean`, which removes merged worktrees and their branches, running `foreman.teardown` first.

### 10. File (file@1)

Done when every ticket of the shift is merged, in the queue, waiting on a person, parked or blocked, and the memo names each. `pnpm factory timings end run` first.

1. **Suggestion box:** `pnpm factory suggestion-box drop <run folder>/suggestions.md` (Suggestions, below).
2. **Performance review (performance-review@1):** when `pnpm factory review-due` prints `due`, start HR (`steps.performance-review`) in the background, described `performance review`, in a worktree on `factory/performance-review-<date>`. Its PRs go up with auto-merge off and wait on a person; ask them on each PR (and in the session when someone watches) to approve, edit or drop each change. A later shift's step 1 acts on an answer there: approved, turn auto-merge on; dropped, close it; and file its proposed tickets.
3. **Memo:** write the shift's input as JSON in the run folder, then `pnpm factory memo <file> --run-dir <run folder>` (`--dry-run` prints it instead). It adds the queue's lines, the usage line, the step medians and the run folder itself. The input, one item per array entry:
   - `mode`, `summary` (this shift, one line), `day` (the day so far, for the title), `intake` (the tickets taken, in order).
   - `mix`: one line, the tickets built by kind (`feature 3, bug 1, tooling 1`), then `; named tickets` or `; epic <n>` for a shift of those, or `none built`.
   - `merged`, `reds` (with the failing step), `stalls`, `timeouts`, `queued`.
   - `calls`: `[#577 🔀](<url>) <the choice>`, a UI screenshot on a second line; accepted unless someone comments.
   - `filed`: the follow-ups the shift filed itself, linked. `proposed`: the judgement calls, which become boxes, ticked to file. `notes`: anything else.

   It stops while a ticked follow-up on an open memo isn't filed: file it with `p3`, end its line with `→ <ticket link>`, and run it again.

4. **Timesheet:** `pnpm factory timesheet` last. Then delete `state.md`, and stop the processes you started.

## Open questions

A question from the ticket, a temp or an inspector is one of four kinds; your mode says whether you ask it or park it:

- **Reversible UI or wording:** take the recommended option (the ticket's, else the agent's, else yours) and record it as a call.
- **Money, data, legal or schema:** comment the question on the ticket with its options and a recommendation. Parking is `pnpm factory park <n> --reason "<question>"`: it keeps the worktree's work on a pushed `park/` branch, gives the claim back and swaps `ready-for-agent` for `decision needed`.
- **A test red on main that blocks a push:** not a question. When the fix touches only tests or their fixtures, fix it in its own PR with auto-merge on, land it before the blocked pushes, and name it under calls.
- **Removes or tightens behaviour** the ticket doesn't ask for: build the rest and push without auto-merge until it is answered (step 6, Removals).

## Follow-ups

Work found along the way that isn't in a ticket goes in the memo, not filed, except the objective ones the shift files itself, after a search for a ticket that already covers it: a tooling bug the shift hit (a box on the project's odd jobs ticket for it), a stale translation a check found, a test red on main. A small objective fix in files the branch already touches goes in its rework instead, as a call. Judgement calls wait as `proposed` memo boxes.

## Suggestions

When the factory itself costs time or tokens (an overrun, a refusal, a queue drop, a rule that misfired, a finding deferred that the ticket covers), add one line to `suggestions.md` in the run folder: what happened, the rule it hit, the cost. Ticket follow-ups go in the memo, not there. Step 10 drops it in the suggestion box, which only HR reads.

## Agents

- **Lean briefs:** the ticket URL, the worktree and branch, the base, the reference screen for UI, which files other agents own right now, the calls already made, the agent's timeout, and for one that pushes what step 8 gives it, plus one line: don't remove or tighten anything the ticket doesn't name; ask. Never brief a temp to decide whether something should exist: that question goes on the ticket. The rest is in the handbooks and the agent's own definition. A brief that seems to need a rule the project lacks means the project handbook needs it: note it in `suggestions.md` rather than growing the brief.
- **Names:** describe every agent `<n> <step>`: `656 build`, `656 quality-control: spec`, `656 rework`, `656 push`, `656 copy-desk`, `656 reality-check`. `pnpm factory usage` groups its rows by them and `pnpm factory timings` takes the timeout from the step.
- **Background:** every agent runs with `run_in_background: true`; its hand-back arrives as a task notification, once, at the end. Keep `in-flight:<n>` tickets moving: when one reaches the queue, parks or blocks, claim the next.
- **A fresh agent per job:** a build, a rework, a copy desk pass. Resume an agent only for a direct follow-up on its own job. Consultants plan and interns find facts when a ticket needs either, before its temp starts.
- **Models:** `opus` for temps and inspectors, `sonnet` for the copy desk, as their definitions say.
- **Only the foreman** files tickets and decides when a branch is pushed and whether auto-merge goes on. A temp briefed to push pushes as told; every other agent commits locally. No agent merges, and neither do you: the merge step does.
- Stop processes you started, and only those.
