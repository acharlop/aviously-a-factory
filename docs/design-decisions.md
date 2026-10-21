# Design decisions

Settled in one grilling session, 2026-10-21 and 22, by Avi. Each decision has a one-line answer; the reasoning is collapsed below.

| # | Question | Decision |
|---|---|---|
| 1 | Where it lives | Repo `acharlop/aviously-a-factory`, shipped as a Claude Code plugin |
| 2 | Which projects | GitHub, TypeScript and pnpm. Turbo, mobile, e2e and i18n are modules |
| 3 | Moving yarcone | One piece at a time while it keeps running ([how](moving-yarcone.md)) |
| 4 | Second project | whocards/app is the definition of done |
| 5 | babysit, agent-layer | The factory replaces them. agent-layer becomes onboarding |
| 6 | Records | Run data per project (paper trail). Rules live in the factory and project handbooks |
| 7 | GitHub owner | acharlop (github.com/Aviously is someone else) |
| 8 | Scripts | `factory` CLI, a devDependency from a git tag, same version as the plugin |
| 9 | Config | `factory.config.ts` |
| 10 | Labels | The factory owns the names; onboarding renames a project's labels |
| 11 | Merge | Every step is swappable and versioned. Mac queue and GitHub-native are two merge versions |
| 12 | Machines | One runner per machine serving every project; machine config holds its roles |
| 13 | "Lane" | Gone. A check is a gate verdict; a shift is a session |
| 14 | strings, ui-reviewer | Become the copy desk and screenshots modules |
| 15 | Global agents | The plugin ships them; global and per-project copies are deleted |
| 16 | Git history | Copy fresh; first commit points at the source commits |
| 17 | Steps | triage, reality check, claim, build, quality control, rework, gate, merge, file, performance review |
| 18 | Step contract | Steps talk only through GitHub state plus a run folder ([ADR 0001](adr/0001-swappable-versioned-steps.md)) |
| 19 | Local steps | Allowed; tagged `local` in the paper trail; promoted by a performance review |
| 20 | Session name | Shift |
| 21 | Shift filters | Set by whoever starts the shift; the project supplies the vocabulary |
| 22 | People-only sessions | Meetings: meeting, water cooler, lost and found |
| 23 | Config format | TS authored, resolved to JSON for hooks and agents; schema per major; `factory migrate` |
| 24 | Versioning | All step versions ship side by side; fixes land in place ([ADR 0001](adr/0001-swappable-versioned-steps.md)) |
| 25 | Names | Obvious first, dry second ([GLOSSARY.md](../GLOSSARY.md)) |
| 26 | "Area" | Department |
| 27 | Kind of work | `kind:` labels: feature, bug, debt, security, tooling |
| 28 | Rotating shifts | A rota in machine config; a shift ends on N merged, empty queue or time cap |
| 29 | Names on disk | Repo and package `aviously-a-factory`, CLI `factory` |
| 30 | Agent names | Temp, inspector, copy desk, receptionist, HR, consultant, intern |
| 31 | "Learnings" | Suggestion box (observations) and handbook (rules) |
| 32 | Paper trail destination | The File step; `file@1` writes to a git repo |
| 33 | Ticket order and default rota | priority, fifo, lifo or alternate; default is one unfiltered priority shift plus a lunch break when the usage limit is hit |
| 34 | Move order | Called before caller; foreman and runner last ([moving-yarcone.md](moving-yarcone.md)) |
| 35 | Onboarding whocards | Right after the foreman moves, supervised only |
| 36 | Global guardrails | Become factory handbook defaults, with per-project exceptions |
| 37 | Yarcone memory files | Sorted into the handbooks or the suggestion box, then deleted |
| 38 | Several developers | One person's machines in v1; every record notes the person and the machine |
| 39 | closer's trpc-migrate retro | Left alone; mined for suggestions when closer onboards |

<details><summary>For AI</summary>

### Reasoning worth keeping

- **5.** Three overlapping pipelines (yarcone factory, babysit, closer's trpc-migrate loop) is debt. Closer's rules, such as merge commits for closer-api and the CodeRabbit and Greptile handling, become project config and a review-bots module.
- **6.** Rules apply to every project; run data doesn't. Sorting by kind lets the performance review open the PR in the right repo.
- **8.** Git hooks and the launchd runner call the scripts with no Claude running. A per-project pin lets each project roll back on its own.
- **11.** Avi's words: the factory "is meant to grow in ways I can't fully even imagine yet and needs to be flexible enough to iterate on them without breaking projects already using it, but benefitting from the findings and fixes from all of them." That sentence is why ADR 0001 exists.
- **12.** The gate is CPU-bound. Two projects' queues on one Mac must share one heavy lock, and one runner is where it lives.
- **13 and 20.** Yarcone used "lane" for three things: the decide lane, the mobile lane and check lanes. "Shift" also covers Avi's "x shifts of features, then x of tech debt".
- **17.** Intake and claim merged: picking a ticket and claiming it is one act, and splitting them is how races happen.
- **23.** From the Better T Stack research: `bts.jsonc` is a record of what was chosen at scaffold time, has no migrations, and its version field is unused. Copied from it: a schema generated from Zod, no unknown keys, an explicit `none`, a `schema` command, and edits that keep comments. Not copied: the unversioned schema URL, and compatibility rules kept only in CLI code.
- **24.** A tag per step major means a backport for every fix. Versioning only the whole factory means a project can't take a new merge without a new review. Side by side costs a contract test per live version in factory CI.
- **34.** The order changed after Avi asked how the move works. The first draft moved the foreman before the gate, merge queue and modules. The foreman calls those, so it would have shipped calling yarcone's old copies by path. Now everything moves before what calls it.
- **35.** Moved with 34: whocards needs a foreman to do anything, so it onboards after move 7 rather than move 5.

</details>
