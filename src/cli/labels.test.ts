import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FACTORY_LABELS } from "../labels.ts";
import type { Exec } from "../runtime/exec.ts";
import { labels } from "./labels.ts";

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "factory-labels-"));
  writeFileSync(
    join(root, "factory.config.ts"),
    'export default { configVersion: 1, labelRenames: { factory: "kind:tooling" } };',
  );
  return root;
};

const fakeGh = (existing: object[]) => {
  const writes: string[][] = [];
  const sh: Exec = (_, args) => {
    if (args[1] === "list") return { status: 0, stdout: JSON.stringify(existing), stderr: "" };
    writes.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { sh, writes };
};

const existing = [
  ...FACTORY_LABELS.filter((label) => label.name !== "kind:tooling"),
  { name: "factory", color: "0e8a16", description: "The agent factory" },
];

test("labels is a dry run unless --apply", async () => {
  const gh = fakeGh(existing);
  assert.equal(await labels([], gh.sh, project()), 0);
  assert.deepEqual(gh.writes, []);
});

test("labels --apply makes the changes, using the project's renames", async () => {
  const gh = fakeGh(existing);
  assert.equal(await labels(["--apply", "--repo", "owner/project"], gh.sh, project()), 0);
  assert.deepEqual(
    gh.writes.map((args) => args.slice(0, 5)),
    [["label", "edit", "factory", "--name", "kind:tooling"]],
  );
});
