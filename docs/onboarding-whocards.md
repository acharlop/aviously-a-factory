# Onboarding whocards

Factory side done. whocards/whocards-platform itself is untouched: everything below is still to do there, by a person, supervised ([#9 📋](https://github.com/acharlop/aviously-a-factory/issues/9)).

Left to do in whocards, in order:

1. `pnpm add -D github:acharlop/aviously-a-factory#v<release>`, and `aviously-a-factory: true` under `allowBuilds` in `pnpm-workspace.yaml`.
2. `.factory/` in `.gitignore`; the plugin enabled in `.claude/settings.json` (the factory's README).
3. `pnpm factory onboard --write`, then edit it to the config below.
4. `pnpm factory labels`, check it matches the plan below, then `pnpm factory labels --apply`.
5. Settings: turn on **Allow auto-merge**. merge@2 lands through it; today it is off.
6. Write `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`) and `docs/agents/`. None exist; CONTEXT.md, docs/ and `.claude/` hold what goes in them.
7. `pnpm factory doctor`, one PR with all of it, merged by a person.
8. First shift: `/aviously-a-factory:foreman supervised` on one small `ready-for-agent` ticket. Done when it merges with no factory code changed for it.

<details><summary>For AI</summary>

### The config

What `factory onboard` prints for whocards (a read-only run, 2026-10-22), plus the edits a person makes in step 3: `labelRenames`, `foreman.setup` and `foreman.security`.

```ts
import { defineConfig } from "aviously-a-factory";

export default defineConfig({
  configVersion: 1,
  departments: ["app", "emails", "mobile", "website"],
  steps: { gate: "none", merge: 2 },
  labelRenames: { backlog: "Parked", refactor: "kind:debt" },
  modules: {
    reviewBots: {
      bots: {
        greptile: {
          login: "greptile-apps",
          verdict: "greptile_confidence_score:(\\d)",
          pass: "^[45]$",
          threads: "findings",
        },
        coderabbit: { login: "coderabbitai", threads: "findings" },
      },
    },
  },
  foreman: {
    setup:
      'pnpm install --frozen-lockfile && cp "$(git rev-parse --path-format=absolute --git-common-dir)/../.env" .env',
    security: ["apps/app/src/server/auth/**", "apps/app/src/routes/api/**", "packages/api/src/**"],
  },
});
```

- **merge@2, gate none.** `main` has a ruleset requiring `Quality gate`, `Website e2e` and `netlify/whocards-calmly/deploy-preview`, strict (up to date first), with linear history. Actions CI runs the first two, so no gate commands run on a Mac. merge@2's pass brings a PR that is behind `main` up to date (`gh pr update-branch`), since GitHub auto-merge never does that itself under the strict rule.
- **Squash.** The repo allows it, and linear history rules out merge commits; the default stands.
- **Departments** are the apps. `packages/api` tickets file under `app` or `website` unless a person adds a department for it. The area labels (`mobile`, `website`, `backend`, `shared`, ...) stay as they are; the factory adds `department:*` beside them.
- **Review bots.** Greptile writes its verdict into the PR body as `<!-- greptile_confidence_score:N -->` and reviews once per PR (`triggerOnUpdates: false`); 4 or 5 passes. CodeRabbit reviews with `Actionable comments posted: N`, so its threads are its verdict. Both skip PRs labelled `skip-pr-bots`; factory PRs never carry it.
- **No mobile module yet.** apps/mobile is Expo, but its device commands (`startDevice`, `runFlows`, ...) are whocards' to write. Until then mobile tickets build with no device stage.
- **No `foreman.migrations`.** Drizzle's schemas are `apps/{app,website}/src/server/db/schema.ts`; `factory push` stops on any change to a migrations glob, so leave it unset until that guard is checked against whocards' migration flow.
- **No paper trail** yet (`paperTrail` defaults to none).

### The label plan

From `gh label list -R whocards/whocards-platform` (read-only, 2026-10-22) with the config above:

| Change                  | Labels                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename                  | `needs-decision` to `decision needed`, `backlog` to `Parked`, `bug` to `kind:bug`, `enhancement` to `kind:feature`, `refactor` to `kind:debt`                                                                                                                                                                    |
| Recolour and redescribe | `blocked`, `in-progress`, `epic`                                                                                                                                                                                                                                                                                 |
| Create                  | `ready-for-agent`, `ready-for-human`, `to-discuss`, `odd jobs`, `recall`, `p1`, `p3`, `kind:security`, `kind:tooling`, `department:app`, `department:emails`, `department:mobile`, `department:website`                                                                                                          |
| Leave alone             | `wayfinder:*`, the area labels (`mobile`, `backend`, `website`, `shared`, `repo`, `infra`, `release`, `ci`, `testing`, `migration`, `chore`, `observability`, `compliance`), `needs-review`, `ai-suggested`, `eas-build`, `dependencies`, `skip-pr-bots`, `skip-greptile`, `documentation` and GitHub's defaults |

### Yarcone-shaped assumptions found, each fixed in the factory

| Assumption                                                                            | Fix                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Merge is the Mac queue: a `QUEUE=on` machine, the heavy lock, gate commands on a Mac  | `merge@2`; `factory queue` runs whichever version `steps.merge` resolves to; the foreman skill's step 2 |
| `factory push` turned auto-merge on with `--squash`, whatever `merge.method` said     | It uses `merge.method`                                                                                  |
| `department:*` labels existed in yarcone already, so `factory labels` never made them | `factory labels` creates one per `departments` entry                                                    |
| pnpm's `onlyBuiltDependencies` (whocards is on pnpm 11's `allowBuilds`)               | README names both; `factory onboard` checks the one the workspace uses                                  |
| Review bots: yarcone has none, so nothing read a bot's verdict                        | The `reviewBots` module and `factory bots <pr>`                                                         |
| Handbook, hook and foreman prose said "the queue lands it"                            | "the merge step"                                                                                        |

Not fixed, because whocards' base is `main` and nothing breaks: `origin/main` is still written into `factory free`, `factory push`, `factory inspectors`, resume and some agent prose, where `gate.base` belongs.

</details>
