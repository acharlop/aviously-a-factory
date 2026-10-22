import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyChange,
  describeChange,
  FACTORY_LABELS,
  type Label,
  listLabels,
  planLabels,
} from "./labels.ts";
import type { Exec } from "./runtime/exec.ts";

const fakeGh = () => {
  const calls: string[][] = [];
  const sh: Exec = (command, args) => {
    assert.equal(command, "gh");
    calls.push(args);
    return { status: 0, stdout: "[]", stderr: "" };
  };
  return { sh, calls };
};

const factory = (name: string) => FACTORY_LABELS.find((label) => label.name === name)!;

test("a repo with exactly the factory set needs nothing", () => {
  assert.deepEqual(planLabels(FACTORY_LABELS), []);
});

test("missing labels are created, old names renamed, and labels the factory doesn't own left alone", () => {
  const existing: Label[] = [
    ...FACTORY_LABELS.filter((label) => !["recall", "odd jobs", "kind:bug"].includes(label.name)),
    { name: "factory-escape", color: "d93f0b", description: "Fixes or undoes a factory PR" },
    { name: "Batch", color: "c5def5", description: "Collects small fixes" },
    { name: "mobile", color: "1d76db", description: "Mobile app" },
  ];
  assert.deepEqual(planLabels(existing), [
    { action: "rename", from: "Batch", label: factory("odd jobs") },
    { action: "rename", from: "factory-escape", label: factory("recall") },
    { action: "create", label: factory("kind:bug") },
  ]);
});

test("a project's own renames add to the factory's", () => {
  const existing = [
    ...FACTORY_LABELS.filter((label) => label.name !== "kind:tooling"),
    { name: "factory", color: "0e8a16", description: "The agent factory" },
  ];
  assert.deepEqual(planLabels(existing, { factory: "kind:tooling" }), [
    { action: "rename", from: "factory", label: factory("kind:tooling") },
  ]);
});

test("a factory label with another colour, description or case is edited", () => {
  const existing = FACTORY_LABELS.map((label) =>
    label.name === "Parked" ? { ...label, name: "parked", color: "80254A" } : label,
  );
  assert.deepEqual(planLabels(existing), [
    { action: "edit", from: "parked", label: factory("Parked") },
  ]);
  const upper = FACTORY_LABELS.map((label) => ({ ...label, color: label.color.toUpperCase() }));
  assert.deepEqual(planLabels(upper), []);
});

test("an old name next to its new one is reported, not touched", () => {
  const existing = [...FACTORY_LABELS, { name: "bug", color: "d73a4a", description: "" }];
  const changes = planLabels(existing);
  assert.deepEqual(changes, [{ action: "conflict", from: "bug", label: factory("kind:bug") }]);
  const { sh, calls } = fakeGh();
  applyChange(changes[0]!, sh);
  assert.deepEqual(calls, []);
  assert.match(describeChange(changes[0]!), /^leave bug: kind:bug exists too/);
});

test("changes become gh label commands, on the named repo if any", () => {
  const { sh, calls } = fakeGh();
  assert.deepEqual(listLabels(sh, "owner/project"), []);
  applyChange({ action: "create", label: factory("p1") }, sh);
  applyChange({ action: "rename", from: "batch", label: factory("odd jobs") }, sh, "owner/project");
  assert.deepEqual(calls, [
    [
      "label",
      "list",
      "--limit",
      "1000",
      "--json",
      "name,color,description",
      "--repo",
      "owner/project",
    ],
    ["label", "create", "p1", "--color", "e11d21", "--description", "Take first"],
    [
      "label",
      "edit",
      "batch",
      "--name",
      "odd jobs",
      "--color",
      "c5def5",
      "--description",
      "A standing ticket that collects small chores of one sort",
      "--repo",
      "owner/project",
    ],
  ]);
});
