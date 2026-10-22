import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig, resolveConfig } from "../../../config/load.ts";
import { frontmatter, pluginFile } from "../../../plugin-files.fixture.ts";
import { reviewedComment } from "../../../runtime/ticket.ts";
import { axesFor, findingsIn, INSPECTORS, inspected, reportFile } from "./step.ts";

const resolved = (config: object) =>
  resolveConfig(parseConfig({ configVersion: 1, ...config }), "/p");

for (const [axis, agent] of Object.entries(INSPECTORS))
  test(`the ${axis} inspector is the read-only plugin agent ${agent}`, () => {
    const { name, tools } = frontmatter(`agents/${agent}.md`);
    assert.equal(name, agent);
    assert.deepEqual(tools!.split(/,\s*/).sort(), ["Bash", "Glob", "Grep", "Read"]);
  });

test("the spec inspector ends with the Removals line the foreman reads", () => {
  assert.match(pluginFile("agents/spec-inspector.md"), /`Removals: none`/);
});

test("spec and standards always; security when a foreman.security glob matches; looks when screenshots are on", () => {
  const files = ["src/api/auth/session.ts", "src/ui/page.tsx"];
  const axes = (config: object) => axesFor(files, resolved(config)).map(({ axis }) => axis);
  assert.deepEqual(axes({}), ["spec", "standards"]);
  assert.deepEqual(axes({ foreman: { security: ["src/api/auth/**"] } }), [
    "spec",
    "standards",
    "security",
  ]);
  assert.deepEqual(axes({ foreman: { security: ["src/db/**"] } }), ["spec", "standards"]);
  const screenshots = { command: "pnpm shots", locales: ["en"], references: "docs/screens.md" };
  assert.deepEqual(axes({ modules: { screenshots } }), ["spec", "standards", "looks"]);
  assert.match(
    axesFor(files, resolved({ foreman: { security: ["**/auth/**"] } }))[2]!.why,
    /touches src\/api\/auth\/session.ts/,
  );
});

test("quality control is done once its report on the head is in the run folder, or the head was Reviewed", () => {
  const head = "c0ffee1234567890";
  assert.equal(reportFile("/runs/d", 7, head), "/runs/d/7-quality-control-c0ffee123456.md");
  assert.equal(findingsIn("Findings: 2\n\n1. a\n2. b"), 2);
  assert.ok(Number.isNaN(findingsIn("two findings")));
  const state = { number: 7, branch: "web/7-a", head, ahead: 1, bodyFile: true, comments: [] };
  assert.ok(!inspected(state));
  assert.ok(inspected({ ...state, report: { findings: 0 } }));
  assert.ok(inspected({ ...state, comments: [{ body: reviewedComment(head.slice(0, 8)) }] }));
});
