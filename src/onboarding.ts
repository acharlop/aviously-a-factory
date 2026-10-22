import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FactoryConfigInput, Merge } from "./config/schema.ts";
import {
  departmentLabel,
  describeChange,
  FACTORY_LABELS,
  type Label,
  planLabels,
} from "./labels.ts";
import type { ReviewBots } from "./modules/schema.ts";
import type { Exec } from "./runtime/exec.ts";
import { ghJson } from "./runtime/github.ts";
import { type Required, requiredChecks } from "./steps/merge/v2/required.ts";
import { FACTORY_VERSION } from "./version.ts";

/** The review bots onboarding recognises by their config file, and how the factory reads each. */
export const KNOWN_BOTS: Record<string, { files: string[]; bot: ReviewBots["bots"][string] }> = {
  greptile: {
    files: ["greptile.json", ".greptile"],
    bot: {
      login: "greptile-apps",
      verdict: "greptile_confidence_score:(\\d)",
      pass: "^[45]$",
      threads: "findings",
    },
  },
  coderabbit: {
    files: [".coderabbit.yaml", ".coderabbit.yml"],
    bot: { login: "coderabbitai", threads: "findings" },
  },
};

/** The project's handbook: what each file is for. Onboarding lists them and never writes one. */
export const HANDBOOK = [
  [
    "AGENTS.md",
    "the project handbook: its domain words, where state lives, decisions not to undo, and its exceptions to the factory handbook",
  ],
  ["CLAUDE.md", "`@AGENTS.md`, so Claude Code reads the same handbook"],
  [
    "docs/agents",
    "the rest of the handbook, one file a subject, such as local-dev.md for commands and gotchas",
  ],
] as const;

export type Facts = {
  repo: string;
  base: string;
  pnpm: boolean;
  turbo: boolean;
  /** Folders under apps/ with a package.json: the departments onboarding suggests. */
  apps: string[];
  /** Apps that depend on expo, which the mobile module may suit. */
  expo: string[];
  actions: boolean;
  required: Required;
  method: Merge["method"];
  autoMerge: boolean;
  bots: string[];
  /** What is already in place, by what a person would otherwise do. */
  has: { dependency: boolean; builds: boolean; gitignore: boolean; plugin: boolean };
  /** The workspace file's key that lets a dependency run its build: pnpm 11's allowBuilds, else onlyBuiltDependencies. */
  buildsKey: "allowBuilds" | "onlyBuiltDependencies";
  handbook: { path: string; why: string; exists: boolean }[];
};

type RepoSettings = {
  allow_squash_merge: boolean;
  allow_rebase_merge: boolean;
  allow_auto_merge: boolean;
};

/** What onboarding reads about the project at root, from its files and from GitHub. */
export function detect(root: string, sh: Exec): Facts {
  const file = (path: string) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
  const manifest = (path: string) =>
    JSON.parse(file(path) ?? "{}") as {
      packageManager?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  const folders = (path: string) =>
    existsSync(join(root, path))
      ? readdirSync(join(root, path), { withFileTypes: true })
          .map(({ name }) => name)
          .sort()
      : [];
  const project = manifest("package.json");
  const apps = folders("apps").filter(
    (app) => /^[a-z0-9-]+$/.test(app) && existsSync(join(root, "apps", app, "package.json")),
  );
  const { nameWithOwner, defaultBranchRef } = ghJson<{
    nameWithOwner: string;
    defaultBranchRef: { name: string };
  }>(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], sh);
  const settings = ghJson<RepoSettings>(["api", `repos/${nameWithOwner}`], sh);
  const workspace = file("pnpm-workspace.yaml") ?? "";
  return {
    repo: nameWithOwner,
    base: defaultBranchRef.name,
    pnpm:
      file("pnpm-lock.yaml") !== undefined || Boolean(project.packageManager?.startsWith("pnpm@")),
    turbo: file("turbo.json") !== undefined,
    apps,
    expo: apps.filter((app) => manifest(`apps/${app}/package.json`).dependencies?.expo),
    actions: folders(".github/workflows").some((name) => /\.ya?ml$/.test(name)),
    required: requiredChecks(defaultBranchRef.name, sh, nameWithOwner),
    method: settings.allow_squash_merge
      ? "squash"
      : settings.allow_rebase_merge
        ? "rebase"
        : "merge",
    autoMerge: settings.allow_auto_merge,
    bots: Object.entries(KNOWN_BOTS)
      .filter(([, { files }]) => files.some((path) => existsSync(join(root, path))))
      .map(([name]) => name),
    has: {
      dependency: Boolean(project.devDependencies?.["aviously-a-factory"]),
      builds: workspace.includes("aviously-a-factory"),
      gitignore: /^\/?\.factory\/?$/m.test(file(".gitignore") ?? ""),
      plugin: (file(".claude/settings.json") ?? "").includes(
        "aviously-a-factory@aviously-a-factory",
      ),
    },
    buildsKey: /^allowBuilds:/m.test(workspace) ? "allowBuilds" : "onlyBuiltDependencies",
    handbook: HANDBOOK.map(([path, why]) => ({ path, why, exists: existsSync(join(root, path)) })),
  };
}

/** merge@2 when GitHub can be the gate: the base requires checks and Actions runs them. */
export const nativeMerge = (facts: Facts) => facts.actions && facts.required.checks.length > 0;

/** The factory.config.ts onboarding suggests: only what differs from the defaults. */
export function starterConfig(facts: Facts): FactoryConfigInput {
  const bots = facts.bots.map((name) => [name, KNOWN_BOTS[name]!.bot]);
  return {
    configVersion: 1,
    ...(facts.apps.length > 0 && { departments: facts.apps }),
    ...(nativeMerge(facts) && { steps: { gate: "none", merge: 2 } }),
    ...(bots.length > 0 && { modules: { reviewBots: { bots: Object.fromEntries(bots) } } }),
    ...(facts.base !== "main" && { gate: { base: facts.base } }),
    ...(facts.method !== "squash" && { merge: { method: facts.method } }),
  };
}

export const configText = (config: FactoryConfigInput) =>
  [
    'import { defineConfig } from "aviously-a-factory";',
    "",
    `export default defineConfig(${JSON.stringify(config, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:")});`,
    "",
  ].join("\n");

/** What a person still does by hand, in order. */
export function personSteps(facts: Facts, written: boolean): string[] {
  const steps: string[] = [];
  if (!facts.pnpm) steps.push("the factory serves pnpm projects: this one doesn't use pnpm");
  if (!facts.has.dependency)
    steps.push(`pnpm add -D github:acharlop/aviously-a-factory#v${FACTORY_VERSION}`);
  if (!facts.has.builds)
    steps.push(
      `list aviously-a-factory under ${facts.buildsKey} in pnpm-workspace.yaml, so pnpm builds the CLI`,
    );
  if (!facts.has.gitignore) steps.push("add .factory/ to .gitignore: factory resolve writes there");
  if (!facts.has.plugin)
    steps.push(
      "enable the aviously-a-factory plugin in .claude/settings.json (the factory's README)",
    );
  if (!written) steps.push("read the config above, then pnpm factory onboard --write");
  steps.push("pnpm factory labels, then pnpm factory labels --apply");
  if (nativeMerge(facts) && !facts.autoMerge)
    steps.push(`turn on "Allow auto-merge" in ${facts.repo}'s settings: merge@2 lands through it`);
  for (const { path, why, exists } of facts.handbook)
    if (!exists) steps.push(`write ${path}: ${why}`);
  for (const app of facts.expo)
    steps.push(
      `apps/${app} is an Expo app: the mobile module needs its device commands, which only the project knows (the modules skill)`,
    );
  steps.push("pnpm factory doctor");
  return steps;
}

/** The onboarding plan, as `factory onboard` prints it. */
export function planLines(
  facts: Facts,
  config: {
    text: string;
    written: boolean;
    labelRenames: Record<string, string>;
    departments: string[];
  },
  labels: readonly Label[],
): string[] {
  const changes = planLabels(labels, config.labelRenames, config.departments);
  const touched = new Set(changes.flatMap((change) => ("from" in change ? [change.from] : [])));
  const owned = new Set(
    [...FACTORY_LABELS, ...config.departments.map(departmentLabel)].map(({ name }) =>
      name.toLowerCase(),
    ),
  );
  const alone = labels
    .map(({ name }) => name)
    .filter((name) => !touched.has(name) && !owned.has(name.toLowerCase()));
  const native = nativeMerge(facts);
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(", ") : "none");
  return [
    `Project: ${facts.repo}, into ${facts.base}`,
    `Found: ${[facts.pnpm && "pnpm", facts.turbo && "turbo", facts.actions && "Actions CI"].filter(Boolean).join(", ") || "nothing known"}; apps: ${list(facts.apps)}; review bots: ${list(facts.bots)}`,
    `Required checks on ${facts.base}: ${list(facts.required.checks)}${facts.required.strict ? " (up to date with it first)" : ""}`,
    native
      ? "Merge: merge@2, GitHub native. GitHub's required checks are the gate, so no gate commands run on a Mac."
      : "Merge: merge@1, the Mac queue. Without required checks and Actions CI, the gate's checks run on a Mac: add them under gate.checks.",
    "",
    `factory.config.ts (${config.written ? "exists; left as it is" : "not written yet"}):`,
    "",
    config.text.trimEnd(),
    "",
    "Labels (pnpm factory labels --apply makes these):",
    ...changes.map((change) => `  ${describeChange(change)}`),
    `  left alone: ${list(alone)}`,
    "",
    "Handbook:",
    ...facts.handbook.map(({ path, exists }) => `  ${exists ? "have" : "missing"} ${path}`),
    "",
    "For a person, in order:",
    ...personSteps(facts, config.written).map((step, at) => `  ${at + 1}. ${step}`),
  ];
}
