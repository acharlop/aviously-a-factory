---
name: modules
description: How a shift uses a project's modules - when the copy desk runs, when screenshots are taken for the looks inspector, and the mobile device stage on the one machine with the simulator. Use when building a ticket in a project whose factory.config.ts switches on translations, screenshots or mobile.
---

# Modules

Read `modules` in `.factory/resolved.json` (`pnpm factory resolve` writes it). A module set to `"none"` is off: skip its section. Commands named below are fields of that module.

## Translations: the copy desk

- After a temp builds, run `changed` with the base appended. When it lists keys, start a fresh `copy-desk` agent, briefed with the worktree, the base and the ticket alone; its definition carries the rest. When it lists none, skip it.
- Rework that added or reworded a source string doesn't push: the copy desk runs again first.
- A ticket that only rewords copy gets no temp: the copy desk makes the change from the ticket, then quality control as for a branch that changed only the source catalog.

## Screenshots: the looks inspector

- A UI change is one that alters what a screen renders. For one, the temp hands back a screenshots folder (taken with `command`, the folder in `SHOTS_DIR`) in every one of `locales`, and a `Shots:` list mapping each done-when line to its file. A done-when line with no shot goes back to the temp before quality control.
- When the branch changed strings, the temp's shots show placeholder copy: after the copy desk, run `SHOTS_DIR=<folder> <command>` in the worktree into the same folder before the looks inspector starts.
- Give the `looks-inspector` that folder and the reference screens the ticket names. Skip it only when the branch has no UI change: server, tooling, docs, logic with no markup change, or strings alone, which the copy desk covers. Each skip is a call naming why.

## Mobile: the device stage

**The device machine.** `pnpm factory mobile device` says whether this machine runs the project's device checks: the one with the simulator, `MOBILE_SIGNOFF=on` in its machine config. Only it builds tickets of the module's `department`; shifts on other machines leave them. A change elsewhere that breaks the mobile app's tests fixes the app in the same PR, and adds a box to the mobile odd jobs naming the PR and what to check on a device.

**One simulator, one ticket.** One ticket is in the device stage at a time, whatever anyone says: one simulator serves one ticket. The next ticket's build may start meanwhile. When `startDevice` refuses because another checkout holds the simulator (a person working by hand), never point the check at another simulator and never take the claim over. The ticket waits at this stage; try again when the next agent hands back. At the end of the shift, leave it with its branch pushed and auto-merge off, and "device check pending" in the memo.

**Native changes need a person.** `pnpm factory mobile native <base>` lists the files and app dependencies that need a new dev build. Dev builds and store builds, on EAS or anywhere else, are a person's: never start one in a shift. Only the gate's mobile check builds one, with `buildDevice`, on the device machine. When it lists anything, build as usual, skip the device stage, push with auto-merge off, and put "device check on a new dev build" in the report. When `startDevice` stops because the dev build is missing or stale, don't rebuild it: put "dev build needed: <the command it printed>" in the memo and treat the ticket as waiting on the simulator.

**The stage.** The temp runs `listFlows` with the base appended before it hands back and names the flows it lists. None: no device stage, the app's unit tests cover it. Otherwise, after the build and beside quality control, run in the worktree as one background command: `startDevice`, then `SHOTS_DIR=<run folder>/<ticket>-shots <runFlows> <the flows listed>`, then `stopDevice`, whatever happened. Give it 10 minutes at most. Take one more screenshot of any changed screen no flow ends on. A failed flow is a finding for rework, which reruns this stage once. No rework edits a worktree while its flows run: the dev server reloads the app mid-flow.

The looks inspector gets the shots folder, with the screen the ticket names as its reference. Push with auto-merge on once the stage passes.

**The gate's check.** With `gate.checks.<name>: { module: "mobile" }`, `factory signoff` and the merge queue run the flows `listFlows` lists between `startDevice` and `stopDevice`, three tries a flow, first building a new dev build with `buildDevice` when a native change needs one. Only the device machine runs it: elsewhere `factory signoff` refuses such a branch and the queue leaves it queued for that machine.
