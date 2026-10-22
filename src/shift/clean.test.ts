import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { parseWorktrees } from "../runtime/worktrees.ts";
import { clean, plan } from "./clean.ts";

const porcelain = `worktree /code/app
HEAD aaaaaaaa1111
branch refs/heads/main

worktree /code/app-wt/600-rate-limit
HEAD bbbbbbbb2222
branch refs/heads/api/600-rate-limit

worktree /code/app-wt/511-discount
HEAD cccccccc3333
branch refs/heads/web/511-discount

worktree /code/app-wt/scratch
HEAD dddddddd4444
detached
`;

test("only a clean worktree whose head its branch's pull request merged is removed, and each kept one says why", () => {
  const dirty = new Set(["/code/app-wt/511-discount"]);
  // The queue merged main onto 600's branch as ffffffff6666, so bbbbbbbb2222 is its ancestor.
  const ancestors = new Set(["bbbbbbbb2222 ffffffff6666"]);
  const sh: Exec = (command, args, options) => {
    if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "merge-base")
      return { status: ancestors.has(args.slice(2).join(" ")) ? 0 : 1, stdout: "", stderr: "" };
    assert.deepEqual([command, ...args], ["git", "status", "--porcelain"]);
    return { status: 0, stdout: dirty.has(options?.cwd ?? "") ? " M file.ts\n" : "", stderr: "" };
  };
  const worktrees = parseWorktrees(porcelain);
  const merged = [
    { number: 776, headRefName: "api/600-rate-limit", headRefOid: "bbbbbbbb2222" },
    { number: 804, headRefName: "web/511-discount", headRefOid: "cccccccc3333" },
  ];
  assert.deepEqual(
    plan(worktrees, merged, sh).map(({ remove, why }) => [remove, why]),
    [
      [true, "#776 merged"],
      [false, "uncommitted changes"],
      [false, "no branch checked out"],
    ],
  );
  const queued = [{ number: 776, headRefName: "api/600-rate-limit", headRefOid: "ffffffff6666" }];
  assert.deepEqual(
    plan(worktrees.slice(0, 2), queued, sh).map(({ remove }) => remove),
    [true],
  );
  const moved = [{ number: 776, headRefName: "api/600-rate-limit", headRefOid: "eeeeeeee5555" }];
  assert.deepEqual(
    plan(worktrees.slice(0, 2), moved, sh).map(({ why }) => why),
    ["head bbbbbbbb has commits #776 didn't merge"],
  );
});

function run(args: string[], teardown?: string, teardownFails = false) {
  const calls: string[] = [];
  const merged = [{ number: 776, headRefName: "api/600-rate-limit", headRefOid: "bbbbbbbb2222" }];
  const sh: Exec = (command, rest, options) => {
    calls.push(`${options?.cwd ?? "."}: ${command} ${rest.join(" ")}`);
    if (command === "gh") return { status: 0, stdout: JSON.stringify(merged), stderr: "" };
    if (rest[0] === "worktree" && rest[1] === "list")
      return { status: 0, stdout: porcelain, stderr: "" };
    if (command === "sh" && teardownFails) return { status: 1, stdout: "", stderr: "db is busy\n" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const log = mock.method(console, "log", () => {});
  try {
    return {
      code: clean(args, teardown, sh),
      calls,
      said: log.mock.calls.map((c) => c.arguments[0]),
    };
  } finally {
    log.mock.restore();
  }
}

test("a removed worktree has the project's teardown run in it first, then goes with its branch", () => {
  const { code, calls } = run([], "pnpm db:drop");
  assert.equal(code, 0);
  const wt = "/code/app-wt/600-rate-limit";
  assert.deepEqual(
    calls.filter((c) => !c.includes("status --porcelain") && !c.includes(" gh ")).slice(-3),
    [
      `${wt}: sh -c pnpm db:drop`,
      `.: git worktree remove ${wt}`,
      ".: git branch -D api/600-rate-limit",
    ],
  );
});

test("a failed teardown is said and the clean goes on; a dry run removes and tears down nothing", () => {
  const failed = run([], "pnpm db:drop", true);
  assert.equal(failed.code, 0);
  assert.ok(
    failed.said.some((line) => /teardown failed in .*600-rate-limit: db is busy/.test(line)),
  );
  const dry = run(["--dry-run"], "pnpm db:drop");
  assert.ok(!dry.calls.some((c) => / sh -c | worktree remove /.test(c)));
  assert.ok(dry.said.some((line) => line.startsWith("would remove /code/app-wt/600-rate-limit")));
  assert.equal(run(["--all"]).code, 2);
});
