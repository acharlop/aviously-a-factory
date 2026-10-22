import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { frontmatter, pluginFileExists } from "../plugin-files.fixture.ts";
import { STEP_VERSIONS } from "./registry.ts";

test("step versions are unique", () => {
  const keys = STEP_VERSIONS.map((step) => `${step.name}@${step.version}`);
  assert.equal(new Set(keys).size, keys.length);
});

for (const step of STEP_VERSIONS)
  test(`${step.name}@${step.version} lives in steps/${step.name}/v${step.version} and has a contract test`, () => {
    assert.ok(Number.isInteger(step.version) && step.version > 0);
    assert.ok(
      existsSync(new URL(`./${step.name}/v${step.version}/contract.test.ts`, import.meta.url)),
    );
  });

for (const step of STEP_VERSIONS.filter((step) => step.agent))
  test(`${step.name}@${step.version} runs the plugin agent agents/${step.agent}.md`, () => {
    assert.ok(pluginFileExists(`agents/${step.agent}.md`));
    assert.equal(frontmatter(`agents/${step.agent}.md`).name, step.agent);
  });
