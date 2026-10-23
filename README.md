# Aviously, a Factory

Agents take a project's tickets to merged PRs. A person shows up only for decisions. One factory, many projects: anything on GitHub with TypeScript and pnpm.

- [How it works](docs/how-it-works.md): five ideas and the diagrams.
- [Moving yarcone onto it](docs/moving-yarcone.md): one name at a time, the caller never notices.
- [GLOSSARY.md](GLOSSARY.md): the words. Foreman, temps, inspectors, shifts, meetings.
- [Design decisions](docs/design-decisions.md): what was decided while designing it, and why.
- [docs/adr](docs/adr): the decisions that are hard to undo.

Status: yarcone runs on it since 2026-10-23 (v0.2.1): every move landed, first shifts green on both Macs ([epic 📋](https://github.com/acharlop/aviously-a-factory/issues/10), [how it went](docs/moving-yarcone.md#how-it-went)). Whocards is next ([#9 📋](https://github.com/acharlop/aviously-a-factory/issues/9)).

## Use it in a project

```sh
pnpm add -D github:acharlop/aviously-a-factory#v0.2.1
```

```ts
// factory.config.ts
import { defineConfig } from "aviously-a-factory";

export default defineConfig({ configVersion: 1 });
```

Enable the plugin in `.claude/settings.json`, from this repo as a marketplace:

```json
{
  "extraKnownMarketplaces": {
    "aviously-a-factory": {
      "source": { "source": "github", "repo": "acharlop/aviously-a-factory" }
    }
  },
  "enabledPlugins": { "aviously-a-factory@aviously-a-factory": true }
}
```

Then `pnpm factory doctor`. pnpm builds the CLI on install, so allow it in `pnpm-workspace.yaml`: `aviously-a-factory: true` under `allowBuilds` from pnpm 11; before it, list it under `onlyBuiltDependencies`.

To set a project up with a person present, use the `onboarding` skill; `pnpm factory onboard` prints the plan it follows.
