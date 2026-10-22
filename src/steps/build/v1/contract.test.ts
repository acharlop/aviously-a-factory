import assert from "node:assert/strict";
import { test } from "node:test";

import { pluginFile } from "../../../plugin-files.fixture.ts";
import { reviewBugs } from "../../file/v1/timesheet.ts";
import { build1, built, PR_BODY } from "./step.ts";

const temp = pluginFile(`agents/${build1.agent}.md`);

test("build@1 is done once the branch has a commit past main and the temp's PR body", () => {
  const state = { number: 7, branch: "web/7-a", head: "abc1234", comments: [] };
  assert.ok(built({ ...state, ahead: 1, bodyFile: true }));
  assert.ok(!built({ ...state, ahead: 0, bodyFile: true }));
  assert.ok(!built({ ...state, ahead: 3, bodyFile: false }));
});

test("the temp writes the PR body where build@1 and factory push look for it", () => {
  assert.ok(temp.includes(`$(git rev-parse --git-path ${PR_BODY})`));
  assert.match(temp, /`pnpm factory push <n> --auto-merge on\|off \[--shots <dir>\]`/);
});

test("the temp's report carries the lines the foreman and the timesheet read", () => {
  assert.match(temp, /`Fails without the fix: yes \(<test names>\)/);
  const heading = /under the heading `([^`]+)`/.exec(temp)?.[1];
  assert.equal(heading, "Bugs fixed from quality control:");
  assert.equal(reviewBugs(`${heading}\n- one\n- two`), 2);
});
