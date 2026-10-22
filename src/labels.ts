import { exec, type Exec } from "./runtime/exec.ts";
import { gh, ghJson } from "./runtime/github.ts";

export type Label = { name: string; color: string; description: string };

/** The labels the factory owns. Every project's labels are made to match these; others are left alone. */
export const FACTORY_LABELS: readonly Label[] = [
  {
    name: "ready-for-agent",
    color: "0e8a16",
    description: "Scoped and decided: one agent can build it end to end",
  },
  {
    name: "decision needed",
    color: "d93f0b",
    description: "An open question blocks it; goes to a meeting",
  },
  {
    name: "ready-for-human",
    color: "5319e7",
    description: "Needs credentials, an account, a console or hands on a device",
  },
  {
    name: "to-discuss",
    color: "c5def5",
    description: "Water cooler: a slow conversation in comments",
  },
  {
    name: "blocked",
    color: "b60205",
    description: "Waits on someone or something outside the repo",
  },
  { name: "Parked", color: "bfbfbf", description: "Not now, by choice" },
  {
    name: "in-progress",
    color: "fbca04",
    description: "Claimed: a shift builds it on the branch its claim comment names",
  },
  { name: "epic", color: "3e4b9e", description: "Groups tickets" },
  {
    name: "odd jobs",
    color: "c5def5",
    description: "A standing ticket that collects small chores of one sort",
  },
  { name: "recall", color: "b60205", description: "Fixes or undoes something the factory shipped" },
  { name: "p1", color: "e11d21", description: "Take first" },
  { name: "p3", color: "fef2c0", description: "Take last" },
  { name: "kind:bug", color: "d73a4a", description: "Broken behaviour" },
  { name: "kind:feature", color: "1d76db", description: "New behaviour" },
  { name: "kind:debt", color: "fbca04", description: "Tech debt" },
  { name: "kind:security", color: "000000", description: "Security" },
  { name: "kind:tooling", color: "5319e7", description: "The factory's own tools" },
];

/** Old names the factory renames in every project. A project adds its own with `labelRenames`. */
export const LABEL_RENAMES: Readonly<Record<string, string>> = {
  "factory-escape": "recall",
  "needs-decision": "decision needed",
  batch: "odd jobs",
  bug: "kind:bug",
  enhancement: "kind:feature",
  security: "kind:security",
};

export type LabelChange =
  | { action: "create"; label: Label }
  | { action: "rename"; from: string; label: Label }
  | { action: "edit"; from: string; label: Label }
  | { action: "conflict"; from: string; label: Label };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The label of a department in factory.config.ts, which the receptionist files tickets under. */
export const departmentLabel = (name: string): Label => ({
  name: `department:${name}`,
  color: "ededed",
  description: `Department: ${name}`,
});

/** What it takes to make `existing` match the factory set and the project's departments. GitHub label names ignore case. */
export function planLabels(
  existing: readonly Label[],
  renames: Readonly<Record<string, string>> = {},
  departments: readonly string[] = [],
): LabelChange[] {
  const all = Object.entries({ ...LABEL_RENAMES, ...renames });
  const changes: LabelChange[] = [];
  for (const label of [...FACTORY_LABELS, ...departments.map(departmentLabel)]) {
    const current = existing.find((each) => same(each.name, label.name));
    const old = existing.filter((each) =>
      all.some(([from, to]) => same(from, each.name) && same(to, label.name)),
    );
    const renamed = current ? undefined : old.shift();
    if (renamed) changes.push({ action: "rename", from: renamed.name, label });
    else if (!current) changes.push({ action: "create", label });
    else if (
      current.name !== label.name ||
      !same(current.color, label.color) ||
      current.description !== label.description
    )
      changes.push({ action: "edit", from: current.name, label });
    for (const each of old) changes.push({ action: "conflict", from: each.name, label });
  }
  return changes;
}

export function describeChange(change: LabelChange): string {
  const { name } = change.label;
  switch (change.action) {
    case "create":
      return `create ${name}`;
    case "rename":
      return `rename ${change.from} to ${name}`;
    case "edit":
      return `update ${change.from === name ? name : `${change.from} to ${name}`}: colour and description`;
    case "conflict":
      return `leave ${change.from}: ${name} exists too; move its tickets to ${name} by hand and delete it`;
  }
}

export function listLabels(sh: Exec = exec, repo?: string): Label[] {
  const repoArgs = repo ? ["--repo", repo] : [];
  return ghJson<Label[]>(
    ["label", "list", "--limit", "1000", "--json", "name,color,description", ...repoArgs],
    sh,
  );
}

export function applyChange(change: LabelChange, sh: Exec = exec, repo?: string): void {
  const { name, color, description } = change.label;
  const repoArgs = repo ? ["--repo", repo] : [];
  const fields = ["--color", color, "--description", description, ...repoArgs];
  if (change.action === "create") gh(["label", "create", name, ...fields], sh);
  else if (change.action !== "conflict")
    gh(["label", "edit", change.from, "--name", name, ...fields], sh);
}
