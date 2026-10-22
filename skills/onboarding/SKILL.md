---
name: onboarding
description: Set a project up for the factory for the first time, with a person present - its factory.config.ts, its labels, its handbook files and the repo settings it needs, each change shown and agreed before it is made. Use when asked to onboard a project, set a repo up for the factory, or install the factory somewhere new.
---

# Onboarding

Setting a project up for the factory, the first time. Supervised only: a person is present and says yes to each change before it is made, because every one of them is visible to everyone on the repo. Nothing here builds a ticket; the first shift comes after.

Run everything in a checkout of the project, on a branch of its own (`factory/onboarding`), never on its default branch.

## 1. The plan

The CLI comes first, on a yes: `pnpm add -D github:acharlop/aviously-a-factory#v<release>`, with `aviously-a-factory` listed under the workspace's build allowance in `pnpm-workspace.yaml` (`allowBuilds` from pnpm 11, `onlyBuiltDependencies` before it). Then `pnpm factory onboard`, which changes nothing. It prints:

- what it found: pnpm, turbo, the apps under `apps/`, Actions CI, the base's required checks, the merge method the repo allows, and the review bots it has config for;
- the starter `factory.config.ts`: the apps as departments, `merge@2` with no gate when the base has required checks and Actions CI runs them, `merge@1` otherwise, and the `reviewBots` module for each bot found;
- the label plan against the factory's labels, and the labels it leaves alone;
- the handbook files the project has and lacks;
- what a person does by hand, in order.

Show it all to the person. Settle the config with them before anything is written: departments they file tickets under (the apps are a guess), the project's own `labelRenames` for its labels that mean a factory one (a `backlog` that means Parked, say), `foreman.setup` for a fresh worktree, `foreman.security` paths, and any module that needs commands only the project knows. A department becomes a `department:<name>` label; the project's own area labels stay as they are.

## 2. The changes, one at a time

Each one only after the person says yes to it:

1. What the plan still lists of `.factory/` in `.gitignore` and the plugin in `.claude/settings.json`.
2. `pnpm factory onboard --write` writes the starter `factory.config.ts`; it never overwrites one. Make the edits agreed in step 1, then `pnpm factory resolve`.
3. `pnpm factory labels` shows the label plan from the config as written. On a yes, `pnpm factory labels --apply`. A `leave` line (both an old and a new label exist) is the person's to sort by hand.
4. The handbook: for each missing file, draft it with the person from what the repo already says (README, CONTEXT.md, docs, existing agent files), and never overwrite one that exists. `AGENTS.md` holds the project's rules: its domain words, where state lives, decisions not to undo, and its exceptions to the factory handbook (the `handbook` skill), such as another merge method. `CLAUDE.md` is `@AGENTS.md`. Put the rest in `docs/agents/`, a file a subject.
5. Repo settings the plan names, such as "Allow auto-merge" for `merge@2`: the person changes them; you never do.
6. `pnpm factory doctor`, then one PR with the config, the handbook and the dependency, auto-merge off. The person merges it.

## 3. What's left

End with a list of what is still the person's, each line a thing to do: settings not yet changed, handbook files still thin, labels left to sort, modules worth turning on later. Then the first shift: `/aviously-a-factory:foreman supervised` on one small ticket.
