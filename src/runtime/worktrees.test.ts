import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorktrees, workingBranch } from "./worktrees.ts";

test("worktrees come from git's porcelain list, the main checkout first; a detached one has no branch", () => {
  const porcelain = [
    "worktree /code/app\nHEAD aaaa1111\nbranch refs/heads/main",
    "worktree /code/app-wt/7-a\nHEAD bbbb2222\nbranch refs/heads/web/7-a",
    "worktree /code/app-wt/x\nHEAD cccc3333\ndetached",
  ].join("\n\n");
  assert.deepEqual(parseWorktrees(`${porcelain}\n`), [
    { path: "/code/app", head: "aaaa1111", branch: "main" },
    { path: "/code/app-wt/7-a", head: "bbbb2222", branch: "web/7-a" },
    { path: "/code/app-wt/x", head: "cccc3333", branch: undefined },
  ]);
});

test("the working branch is the ticket's own, never a parked one or another number's", () => {
  const branches = ["main", "park/866-sign-in", "auth/8660-other", "auth/866-sign-in"];
  assert.equal(workingBranch(branches, 866), "auth/866-sign-in");
  assert.equal(workingBranch(branches.slice(0, 3), 866), undefined);
});
