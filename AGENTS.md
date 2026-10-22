# Aviously, a Factory: working in this repo

Read [GLOSSARY.md](GLOSSARY.md) first and use its words; its _Avoid_ lists are binding. Design: [docs/how-it-works.md](docs/how-it-works.md), [docs/moving-yarcone.md](docs/moving-yarcone.md), [ADR 0001](docs/adr/0001-swappable-versioned-steps.md).

## Layout

- `src/cli/main.ts`: the `factory` CLI. One entry in `COMMANDS` per command.
- `src/config/`: `factory.config.ts` schema (Zod, strict, `configVersion`), loading, resolving to `.factory/resolved.json`. `schema/v<N>.json` is generated: `pnpm factory schema > schema/v1.json`.
- `src/runtime/`: what every step shares: `exec`, `github`, the machine config (`~/.factory`), marks and transcripts.
- `src/steps/<name>/v<N>/`: one step version, registered in `src/steps/registry.ts`, with a `contract.test.ts`. Fixes edit a version in place; new behaviour is a new number.
- `.claude-plugin/`, `skills/`, `agents/`, `hooks/`: the Claude Code plugin. Its version always equals `package.json`'s.

## Commands

`pnpm verify` runs format check, lint, types, tests and build. Run it before every push. `pnpm factory <cmd>` runs the CLI from source.

## Porting a piece from yarcone

- Source: `~/code/yarcone` (Yarcone/yarcone) and `~/code/factory-log` (Yarcone/factory-log). Read only; never change those repos from here.
- Replace each yarcone constant (paths, machine names, label names, script names, `~/.yarcone-factory`) with a `factory.config.ts` field, a machine config field (`~/.factory/machine`) or a glossary word. Nothing yarcone-specific stays in code.
- Tests come with the code. Node's built-in runner, colocated `*.test.ts`.
- Every record a step writes notes the person, the machine, the `step@version` and the factory release.
- The PR body names the yarcone or factory-log commit each piece came from.
