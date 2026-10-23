# Moving yarcone onto the factory

Done 2026-10-23: eight moves, four yarcone PRs, each landed through the queue that was live at the time ([how it went](#how-it-went)).

Swap what a name points at, one name at a time. Yarcone's skills call `pnpm factory:free`; today that runs yarcone's script, after the move it runs `factory free`. The caller never notices. Delete yarcone's copy the same day.

Move what gets called before what calls it. The foreman and the runner call everything, so they go last.

Undo a move by reverting yarcone's one PR: the old script comes back, or the pin drops to the previous factory tag.

```mermaid
flowchart LR
  subgraph before["Before"]
    s1["yarcone skill"] -->|pnpm factory:free| y1["packages/tooling/factory/free.ts"]
  end
  subgraph during["During one move"]
    s2["yarcone skill (unchanged)"] -->|pnpm factory:free| a2["package.json: factory free"] --> f2["aviously-a-factory: claim@1"]
  end
  subgraph after["After the last move"]
    p3["factory plugin skill"] -->|factory free| f3["aviously-a-factory: claim@1"]
  end
  before --> during --> after
```

## The order

Each row is one factory release plus one yarcone PR, landed between shifts, never while a lights-out shift holds the lock.

| #   | Move                                            | What yarcone deletes                                                  | Why here                                                                    |
| --- | ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Skeleton: `factory.config.ts`, `factory doctor` | nothing                                                               | Proves the pin and config work. Does nothing else                           |
| 2   | Paper trail and the File step                   | `factory:ledger`, `factory:digest`, `signoff-record`                  | Only writes records; nothing reads them back mid-shift                      |
| 3   | Hooks and labels                                | `no-hook-bypass`, `link-icons`, old label names                       | Leaves; label renames ship in the same PR as the skill text that names them |
| 4   | Reality check, Receptionist, meetings           | `preflight`, `triager`, the decide, discuss and sweep skills          | Called by a person or the runner, never by a shift                          |
| 5   | Gate and merge queue                            | `merge-queue.ts`, `queue-*`, `stages`, `review-gate`, `signoff`       | Biggest code, but called only by name from the runner                       |
| 6   | Modules: copy desk, screenshots, mobile         | `strings`, `ui-reviewer`, mobile lane pieces                          | The foreman calls them, so they move before it                              |
| 7   | Foreman: claim, build, quality control, rework  | `yarcone-factory` skill, `coder`, `reviewer`, the rest of `factory:*` | Calls everything above. Whocards onboards right after                       |
| 8   | Runner and rota                                 | `factory-log/runner`, `~/.yarcone-factory`                            | Calls the foreman, so it goes last                                          |

```mermaid
flowchart TB
  r["8 Runner and rota"] --> f["7 Foreman"]
  r --> q["5 Gate and merge queue"]
  r --> m4["4 Receptionist and meetings"]
  f --> mod["6 Modules"]
  f --> q
  f --> rc["4 Reality check"]
  f --> h["3 Hooks and labels"]
  f --> pt["2 Paper trail"]
  q --> pt
  pt --> sk["1 Skeleton"]
```

An arrow means "calls". Move from the bottom up.

<details><summary>For AI</summary>

### One move, step by step

1. In aviously-a-factory, copy the piece over. Replace each yarcone constant (paths, machine names, label names, script names) with a `factory.config.ts` field. Its tests move with it.
2. Release a factory tag.
3. In a yarcone worktree, bump the pin. Point the `package.json` script at `factory <cmd>` (or point the skill text at the plugin's agent name). Delete yarcone's copy and its tests. Add the config fields it needs.
4. Verify locally: the moved piece's tests, `pnpm verify`, then one supervised shift on a real ticket. Push once.
5. Note the move in the yarcone memo, so the next performance review knows which step versions changed.

While iterating, link the factory checkout (`pnpm link ~/code/aviously-a-factory`) instead of cutting a tag per try. Merge only against a tag.

### Temporary duplication

`packages/tooling/factory/github.ts`, `config.ts` and `marks.ts` are shared by many scripts. The factory gets its own copies at move 2. Yarcone keeps its copies until its last caller moves (move 7), then deletes them. This is the one place code exists twice during the move. It is deliberate and it has an end date.

### Aliases

The `pnpm factory:*` aliases exist only during the move. After move 8, plugin skills call `factory <cmd>` directly. Delete the aliases, and the `pnpm -s factory:*` entries in the global `~/.claude/settings.json` allowlist.

### Carried over, not copied

- `factory-tick`'s feedback step asks for SKILL.md step 2, Feedback, which no longer exists (digest feedback lives in yarcone-decide step 2). The runner's memos step points it at the `meeting` skill's step 2, Memos, which runs alone unattended for exactly this.
- The weekly step called a `security:weekly` script that main never had. Dropped: the security inspector already judges every change that touches a `foreman.security` path, and a periodic audit is a `kind:security` ticket like any other.

### Also sorted during the move

- About 30 memory files in `~/code/mac-setup/claude/memory/code-yarcone/` go to the factory handbook, yarcone's handbook or the suggestion box, and are deleted as they move. Personal and single-machine notes stay.
- `factory-log` becomes yarcone's paper trail repo and `signoff-runs` folds into it (move 2). Its 36 KB `learnings.md` is split into suggestion box entries and handbook rules.

</details>

## How it went

Landed 2026-10-23 as four PRs: [#1223 🔀](https://github.com/Yarcone/yarcone/pull/1223) (moves 1 and 2), [#1225 🔀](https://github.com/Yarcone/yarcone/pull/1225) (3 and 4), [#1236 🔀](https://github.com/Yarcone/yarcone/pull/1236) (5, 6 and 7), [#1234 🔀](https://github.com/Yarcone/yarcone/pull/1234) (8), plus factory-log [#45 🔀](https://github.com/Yarcone/factory-log/pull/45). The first three went through yarcone's old queue; move 8 and the first two shifts went through `factory queue`. Yarcone epic: [#1211 📋](https://github.com/Yarcone/yarcone/issues/1211).

What the plan did not say, for the next project:

- **Moves 5 and 6 land together.** `main` required `signoff/mobile`, and the gate posts only the checks its config lists, so a gate without the mobile check can never auto-merge.
- **Stacked PRs die with their base.** GitHub closed two PRs when a squash deleted the branch they were based on. Rebase each move onto `main` once the one before it lands, and never squash into a stacked base.
- **The plugin is per machine, per user.** `factory doctor` reads `~/.claude/plugins/installed_plugins.json`; `.claude/settings.json` enabling it is not enough. `claude plugin marketplace add acharlop/aviously-a-factory && claude plugin install aviously-a-factory@aviously-a-factory` on every Mac.
- **The old queue's removal guard.** A PR that deletes factory files needs the project's `removal-ok` label, which the moves did from move 2 on.
- **pnpm pins the commit.** On pnpm 12 `allowBuilds` needs the full `aviously-a-factory@git+https://...#<sha>` key, so a tag bump edits it too.
- **A runner over SSH needs a login shell** (`zsh -lc`) for brew, gh and colima on an Intel Mac.

Gaps the move found in v0.2.1, with the exact text, are in the For AI sections of the four PRs; none blocked a shift.
