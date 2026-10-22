import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { reviewedComment, type TicketState } from "../runtime/ticket.ts";
import { reportFile } from "../steps/quality-control/v1/step.ts";
import { nextStep, ticketState } from "./resume.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";
const state = (overrides: Partial<TicketState> = {}): TicketState => ({
  number: 7,
  branch: "web/7-a",
  head: HEAD,
  ahead: 2,
  bodyFile: true,
  comments: [],
  ...overrides,
});

test("a crashed shift resumes each ticket at the first step whose output is missing", () => {
  assert.equal(nextStep(state({ ahead: 0 })), "build");
  assert.equal(nextStep(state({ bodyFile: false })), "build");
  assert.equal(nextStep(state()), "quality-control");
  assert.equal(nextStep(state({ report: { findings: 2 } })), "rework");
  assert.equal(nextStep(state({ report: { findings: 0 } })), "push");
  const reviewed = [{ body: reviewedComment(HEAD.slice(0, 10)) }];
  assert.equal(nextStep(state({ comments: reviewed })), "push");
  assert.equal(nextStep(state({ comments: reviewed, pr: { url: "u", autoMerge: true } })), "merge");
  assert.equal(
    nextStep(state({ comments: reviewed, pr: { url: "u", autoMerge: false } })),
    "waits: auto-merge is off",
  );
  assert.equal(
    nextStep(state({ comments: [{ body: reviewedComment("deadbeef") }] })),
    "quality-control",
  );
});

test("the state comes from git, the PR body in the worktree's git dir, the run folder's report and the open PRs", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-resume-"));
  const gitDir = join(root, "git");
  mkdirSync(gitDir);
  writeFileSync(join(gitDir, "factory-pr-body.md"), "# Web: a\n\nbody\n");
  const runDir = join(root, "run");
  mkdirSync(runDir);
  writeFileSync(reportFile(runDir, 7, HEAD), "Findings: 3\n\n1. ...\n");
  const sh: Exec = (_, args, options) => {
    const out = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "rev-parse" && args.includes("--git-path")) {
      assert.equal(options?.cwd, "/wt/7-a");
      return out(join(gitDir, "factory-pr-body.md"));
    }
    if (args[0] === "rev-parse") return out(`${HEAD}\n`);
    assert.deepEqual(args, ["rev-list", "--count", "origin/trunk..web/7-a"]);
    return out("4\n");
  };
  const found = ticketState(
    { number: 7, branch: "web/7-a", comments: [] },
    {
      worktrees: [{ path: "/wt/7-a", head: HEAD, branch: "web/7-a" }],
      base: "origin/trunk",
      prs: [
        { url: "https://github.com/o/app/pull/9", headRefName: "web/7-a", autoMergeRequest: {} },
      ],
      runDir,
    },
    sh,
  );
  assert.deepEqual(found, {
    number: 7,
    branch: "web/7-a",
    head: HEAD,
    ahead: 4,
    bodyFile: true,
    comments: [],
    report: { findings: 3 },
    pr: { url: "https://github.com/o/app/pull/9", autoMerge: true },
  });
});
