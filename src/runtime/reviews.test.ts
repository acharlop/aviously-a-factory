import assert from "node:assert/strict";
import { test } from "node:test";

import type { Exec } from "./exec.ts";
import { reviewBlockers, reviewRefusal } from "./reviews.ts";

const thread = (
  isResolved: boolean,
  path: string,
  line: number | null,
  body = "Fix this.\nMore.",
) => ({
  isResolved,
  path,
  line,
  comments: { nodes: [{ author: { login: "macroscopeapp" }, body }] },
});

const page = (threads: ReturnType<typeof thread>[], reviewDecision: string | null = null) => ({
  data: { repository: { pullRequest: { reviewDecision, reviewThreads: { nodes: threads } } } },
});

function gh(pages: ReturnType<typeof page>[]) {
  const asked: string[][] = [];
  const sh: Exec = (command, args) => {
    asked.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify(pages), stderr: "" };
  };
  return { sh, asked };
}

test("each open review thread blocks, by path:line, its first comment's author and first line; resolved ones don't", () => {
  const { sh, asked } = gh([
    page([thread(true, "a.ts", 3), thread(false, "b.ts", 12), thread(false, "c.ts", null)]),
  ]);
  assert.deepEqual(reviewBlockers(1031, sh), [
    "open review thread at b.ts:12 by macroscopeapp: Fix this.",
    "open review thread at c.ts by macroscopeapp: Fix this.",
  ]);
  const args = asked[0]!;
  assert.deepEqual(args.slice(0, 5), ["gh", "api", "graphql", "--paginate", "--slurp"]);
  assert.ok(args.includes("number=1031") && args.includes("owner={owner}"));
});

test("every page of threads counts", () => {
  const { sh } = gh([page([thread(true, "a.ts", 1)]), page([thread(false, "z.ts", 9)])]);
  assert.deepEqual(reviewBlockers(7, sh), [
    "open review thread at z.ts:9 by macroscopeapp: Fix this.",
  ]);
});

test("changes requested blocks; resolved threads and no decision, or approval, don't", () => {
  assert.deepEqual(reviewBlockers(1, gh([page([], "CHANGES_REQUESTED")]).sh), [
    "a reviewer requested changes",
  ]);
  assert.deepEqual(reviewBlockers(1, gh([page([thread(true, "a.ts", 1)], "APPROVED")]).sh), []);
  assert.deepEqual(reviewBlockers(1, gh([page([])]).sh), []);
});

test("gh failing throws with its error, and the refusal names the pull request and each blocker", () => {
  const failing: Exec = () => ({ status: 1, stdout: "", stderr: "HTTP 502" });
  assert.throws(() => reviewBlockers(1, failing), /HTTP 502/);
  assert.match(
    reviewRefusal(5, ["a reviewer requested changes"]),
    /^#5 can't merge.*\n {2}- a reviewer requested changes$/,
  );
});
