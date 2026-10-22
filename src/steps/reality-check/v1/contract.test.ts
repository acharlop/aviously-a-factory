import assert from "node:assert/strict";
import { test } from "node:test";

import { frontmatter, pluginFile } from "../../../plugin-files.fixture.ts";
import { realityCheck1 } from "./step.ts";

const agent = `agents/${realityCheck1.agent}.md`;

test("the reality check is read-only", () => {
  const tools = frontmatter(agent).tools!.split(/,\s*/);
  assert.deepEqual(tools.sort(), ["Bash", "Glob", "Grep", "Read"]);
  assert.match(pluginFile(agent), /never comment, edit or label anything/);
});

test("the reality check reports OK or its corrections, which the meeting reads", () => {
  assert.match(pluginFile(agent), /`#<n>: OK` or `#<n>: <k> corrections`/);
  assert.match(pluginFile("skills/meeting/SKILL.md"), /comment `Reality check at <sha>`/);
});
