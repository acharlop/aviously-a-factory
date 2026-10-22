import assert from "node:assert/strict";
import { test } from "node:test";

import type { Exec } from "../../../runtime/exec.ts";
import { giveBack, park, parkName } from "./park.ts";

const worktrees = `worktree /code/app
HEAD aaaaaaaa1111
branch refs/heads/main

worktree /code/app-wt/866-sign-in
HEAD bbbbbbbb2222
branch refs/heads/auth/866-sign-in
`;

const parking = {
  number: 866,
  reason: "the refund rule is a money call",
  runDir: "/runs/2026-10-17",
  repo: "o/app",
  machine: "avi@studio",
};
const WT = "/code/app-wt/866-sign-in";

/** A fake git whose answers the test sets per subcommand, recording each call with its folder. */
function fakeGit(refuse: { commit?: string; noVerify?: string; push?: string } = {}, dirty = true) {
  const calls: string[] = [];
  const sh: Exec = (command, args, options) => {
    assert.equal(command, "git");
    calls.push(`${options?.cwd ?? "."}: ${args.join(" ")}`);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    const no = (stderr: string) => ({ status: 1, stdout: "", stderr });
    switch (args[0]) {
      case "for-each-ref":
        return ok("main\npark/86-old\nauth/866-sign-in\nauth/8660-other\n");
      case "worktree":
        return ok(worktrees);
      case "status":
        return ok(dirty ? " M src/page.tsx\n?? src/new.ts\n" : "");
      case "diff":
        return ok("diff --git a/src/page.tsx b/src/page.tsx\n");
      case "commit":
        if (args[1] === "--no-verify") return refuse.noVerify ? no(refuse.noVerify) : ok();
        return refuse.commit ? no(`pre-commit: ...\n${refuse.commit}\n`) : ok();
      case "push":
        return refuse.push ? no(refuse.push) : ok();
      default:
        return ok();
    }
  };
  const written = new Map<string, string>();
  return { sh, calls, written, write: (file: string, text: string) => written.set(file, text) };
}

test("a park branch keeps the ticket's slug, and giving back swaps the route for decision needed", () => {
  assert.equal(parkName("auth/866-sign-in"), "park/866-sign-in");
  assert.deepEqual(giveBack(866).slice(3), [
    "--remove-assignee",
    "@me",
    "--remove-label",
    "in-progress",
    "--remove-label",
    "ready-for-agent",
    "--add-label",
    "decision needed",
  ]);
});

test("uncommitted work is saved as a patch, committed with the hooks, and the branch pushed as park/", () => {
  const { sh, calls, written, write } = fakeGit();
  const parked = park(parking, sh, write);
  assert.deepEqual(calls.slice(2), [
    `${WT}: status --porcelain`,
    `${WT}: add -A`,
    `${WT}: diff --cached --binary HEAD`,
    `${WT}: commit -q -m Parked: work in progress -m https://github.com/o/app/issues/866`,
    `${WT}: branch -m auth/866-sign-in park/866-sign-in`,
    `${WT}: push --no-verify -u origin park/866-sign-in`,
  ]);
  assert.deepEqual([...written.keys()], ["/runs/2026-10-17/park-866-sign-in.patch"]);
  assert.ok(parked.ok);
  assert.equal(
    parked.comment,
    "Parked: the refund rule is a money call\n\nWork: branch [`park/866-sign-in`](https://github.com/o/app/tree/park/866-sign-in).\nIts last commit holds the work that was uncommitted.",
  );
});

test("work the hooks refuse is committed past them and pushed on the park branch", () => {
  const { sh, calls, write } = fakeGit({ commit: "lint: a rule failed" });
  const parked = park(parking, sh, write);
  assert.deepEqual(calls.slice(6), [
    `${WT}: commit --no-verify -q -m Parked: work in progress -m https://github.com/o/app/issues/866`,
    `${WT}: branch -m auth/866-sign-in park/866-sign-in`,
    `${WT}: push --no-verify -u origin park/866-sign-in`,
  ]);
  assert.ok(parked.ok);
  assert.ok(parked.said.some((line) => line.includes("lint: a rule failed")));
  assert.match(parked.comment, /committed past the hooks/);
});

test("work that can't be committed even past the hooks stays uncommitted and in a patch", () => {
  const { sh, calls, write } = fakeGit({
    commit: "pre-commit: dead code",
    noVerify: "fatal: unable to write new index file",
  });
  const parked = park(parking, sh, write);
  assert.deepEqual(calls.slice(7), [
    `${WT}: reset -q`,
    `${WT}: branch -m auth/866-sign-in park/866-sign-in`,
    `${WT}: push --no-verify -u origin park/866-sign-in`,
  ]);
  assert.ok(!parked.ok);
  assert.match(
    parked.comment,
    /Uncommitted work that couldn't be committed: `\/runs\/2026-10-17\/park-866-sign-in.patch` on avi@studio/,
  );
});

test("a refused push still parks, and the comment says the branch is on this machine only", () => {
  const { sh, write } = fakeGit({ push: "pre-push: verify failed" }, false);
  const parked = park(parking, sh, write);
  assert.ok(!parked.ok);
  assert.equal(
    parked.comment,
    "Parked: the refund rule is a money call\n\nWork: branch `park/866-sign-in`, on avi@studio only: the push failed (pre-push: verify failed).",
  );
});

test("a patch that can't be read stops the park before any commit or rename", () => {
  const { sh, calls, written, write } = fakeGit();
  const failing: Exec = (command, args, options) =>
    args[0] === "diff"
      ? { status: 128, stdout: "", stderr: "fatal: bad object HEAD" }
      : sh(command, args, options);
  assert.deepEqual(park(parking, failing, write), {
    ok: false,
    said: ["couldn't save the uncommitted work, so nothing moved: fatal: bad object HEAD"],
    comment: "",
  });
  assert.equal(written.size, 0);
  assert.deepEqual(calls.slice(-2), [`${WT}: add -A`, `${WT}: reset -q`]);
});

test("no working branch parks nothing", () => {
  const { sh, calls, write } = fakeGit();
  assert.deepEqual(park({ ...parking, number: 86 }, sh, write), {
    ok: false,
    said: ["no <department>/86-<slug> branch here"],
    comment: "",
  });
  assert.equal(calls.length, 1);
});
