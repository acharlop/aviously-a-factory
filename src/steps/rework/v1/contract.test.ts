import assert from "node:assert/strict";
import { test } from "node:test";

import { pluginFile } from "../../../plugin-files.fixture.ts";
import { reviewedAt, reviewedComment } from "../../../runtime/ticket.ts";
import { reworked, rework1 } from "./step.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";
const state = { number: 7, branch: "web/7-a", head: HEAD, ahead: 1, bodyFile: true, comments: [] };

test("rework@1 is done once the head is Reviewed, or quality control found nothing", () => {
  assert.ok(!reworked(state));
  assert.ok(!reworked({ ...state, report: { findings: 1 } }));
  assert.ok(reworked({ ...state, report: { findings: 0 } }));
  assert.ok(reworked({ ...state, comments: [{ body: reviewedComment(HEAD) }] }));
  assert.ok(!reworked({ ...state, comments: [{ body: reviewedComment("deadbeef") }] }));
});

test("the Reviewed comment the temp writes by hand is the one rework@1 reads", () => {
  const temp = pluginFile(`agents/${rework1.agent}.md`);
  const written = /comment "(Reviewed at `<head sha>`)"/.exec(temp)?.[1];
  assert.equal(written, reviewedComment("<head sha>"));
  assert.ok(reviewedAt([{ body: written!.replace("<head sha>", HEAD) }], HEAD));
});
