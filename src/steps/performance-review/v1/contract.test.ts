import assert from "node:assert/strict";
import { test } from "node:test";

import { frontmatter, pluginFile } from "../../../plugin-files.fixture.ts";
import { performanceReview1, reviewDue } from "./step.ts";

const agent = `agents/${performanceReview1.agent}.md`;

test("a review is due 20 hours after the last one, or when there has been none", () => {
  const now = Date.parse("2026-10-19T15:00:00Z");
  assert.equal(reviewDue(undefined, now), "due");
  assert.equal(reviewDue("2026-10-18T18:59:59Z", now), "due");
  assert.equal(
    reviewDue("2026-10-19T09:22:23Z", now),
    "not due: the last performance review was at 2026-10-19T09:22:23Z (5 h ago)",
  );
});

test("HR reads the suggestion box and records the review through the paper trail, and never merges", () => {
  const text = pluginFile(agent);
  assert.equal(frontmatter(agent).name, "hr");
  assert.match(text, /`pnpm factory suggestion-box list`/);
  assert.match(text, /`pnpm factory review-done --through <the path from step 1> <each PR url>`/);
  assert.match(text, /Factory handbook[\s\S]*Project handbook/);
  assert.match(text, /Never turn auto-merge on, merge, or file tickets/);
});

test("the foreman drops the shift's suggestions, then starts HR only when factory review-due prints due", () => {
  const skill = pluginFile("skills/foreman/SKILL.md");
  assert.ok(skill.includes("`pnpm factory suggestion-box drop <run folder>/suggestions.md`"));
  assert.ok(
    skill.includes(
      "when `pnpm factory review-due` prints `due`, start HR (`steps.performance-review`)",
    ),
  );
});
