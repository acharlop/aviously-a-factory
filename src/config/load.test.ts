import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { StepVersion } from "../steps/step.ts";
import { ConfigError, findProjectRoot, loadProject, parseConfig, resolveConfig } from "./load.ts";
import { schemaFor } from "./schema.ts";

const project = (config: string) => {
  const root = mkdtempSync(join(tmpdir(), "factory-config-"));
  writeFileSync(join(root, "factory.config.ts"), config);
  return root;
};

const REGISTRY: StepVersion[] = [
  { name: "review", version: 1, summary: "one inspector", deprecated: "use review@2" },
  { name: "review", version: 2, summary: "several inspectors" },
  { name: "review", version: 3, summary: "inspectors by axis" },
  { name: "merge", version: 1, summary: "Mac queue" },
];

test("finds the config from a nested directory", () => {
  const root = project("export default { configVersion: 1 };");
  assert.equal(findProjectRoot(join(root, "a", "b")), root);
});

test("loading writes resolved.json with the factory version", async () => {
  const root = project(
    "const config: { configVersion: 1 } = { configVersion: 1 };\nexport default config;",
  );
  const resolved = await loadProject(root);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, ".factory", "resolved.json"), "utf8")),
    resolved,
  );
  assert.equal(resolved.configVersion, 1);
  assert.match(resolved.factoryVersion, /^\d+\.\d+\.\d+$/);
});

test("unknown keys are refused", () => {
  assert.throws(() => parseConfig({ configVersion: 1, mergeMethod: "squash" }), ConfigError);
});

test("an unknown config version is refused", () => {
  assert.throws(() => parseConfig({ configVersion: 2 }), ConfigError);
});

test("a pin must name a step and a version this release ships", () => {
  const schema = schemaFor(REGISTRY);
  assert.throws(
    () => parseConfig({ configVersion: 1, steps: { reveiw: 2 } }, schema),
    /no step called "reveiw"/,
  );
  assert.throws(
    () => parseConfig({ configVersion: 1, steps: { review: 4 } }, schema),
    /review@4 does not exist/,
  );
});

test("the paper trail is none unless the project names a repo, whose layout then takes its defaults", () => {
  assert.equal(resolveConfig(parseConfig({ configVersion: 1 }), "/p").paperTrail, "none");
  assert.deepEqual(
    resolveConfig(parseConfig({ configVersion: 1, paperTrail: { repo: "o/trail" } }), "/p")
      .paperTrail,
    {
      repo: "o/trail",
      timesheet: "timesheets/shifts.jsonl",
      signOffs: "sign-offs",
      memoLabel: "memo",
    },
  );
  assert.throws(
    () => parseConfig({ configVersion: 1, paperTrail: { repo: "trail" } }),
    /owner\/name/,
  );
});

test("a label rename must end at a factory label", () => {
  assert.throws(
    () => parseConfig({ configVersion: 1, labelRenames: { factory: "tooling" } }),
    /"tooling" is not a factory label/,
  );
  assert.deepEqual(
    parseConfig({ configVersion: 1, labelRenames: { factory: "kind:tooling" } }).labelRenames,
    { factory: "kind:tooling" },
  );
});

test("pins resolve to a version, none, or a local path; unpinned steps take their oldest live version", () => {
  const config = parseConfig(
    { configVersion: 1, steps: { review: 1, merge: { local: "steps/merge.ts" } } },
    schemaFor(REGISTRY),
  );
  assert.deepEqual(resolveConfig(config, "/p", REGISTRY).steps, {
    merge: { local: "/p/steps/merge.ts" },
    review: { version: 1, summary: "one inspector", deprecated: "use review@2" },
  });
  const unpinned = parseConfig({ configVersion: 1, steps: { merge: "none" } }, schemaFor(REGISTRY));
  assert.deepEqual(resolveConfig(unpinned, "/p", REGISTRY).steps, {
    merge: "none",
    review: { version: 2, summary: "several inspectors" },
  });
});

test("departments resolve as written, none by default", () => {
  assert.deepEqual(resolveConfig(parseConfig({ configVersion: 1 }), "/p").departments, []);
  const config = parseConfig({ configVersion: 1, departments: ["web", "api"] });
  assert.deepEqual(resolveConfig(config, "/p").departments, ["web", "api"]);
  assert.throws(() => parseConfig({ configVersion: 1, departments: ["Web App"] }), ConfigError);
});
