import { existsSync, readFileSync } from "node:fs";

import type { Exec } from "../runtime/exec.ts";
import type { TicketState } from "../runtime/ticket.ts";
import type { Worktree } from "../runtime/worktrees.ts";
import { built, PR_BODY } from "../steps/build/v1/step.ts";
import { findingsIn, inspected, reportFile } from "../steps/quality-control/v1/step.ts";
import { reworked } from "../steps/rework/v1/step.ts";

/** The first step whose output is missing, which a resumed shift carries the ticket to next. */
export function nextStep(state: TicketState): string {
  if (!built(state)) return "build";
  if (!inspected(state)) return "quality-control";
  if (!reworked(state)) return "rework";
  if (!state.pr) return "push";
  return state.pr.autoMerge ? "merge" : "waits: auto-merge is off";
}

export type OpenPr = { url: string; headRefName: string; autoMergeRequest: object | null };

/** What git, GitHub and the run folder show of a claimed ticket on a branch here. */
export function ticketState(
  claim: { number: number; branch: string; comments: { body: string }[] },
  {
    worktrees,
    prs,
    runDir,
    base,
  }: { worktrees: readonly Worktree[]; prs: readonly OpenPr[]; runDir: string; base: string },
  sh: Exec,
): TicketState {
  const { number, branch, comments } = claim;
  const git = (args: string[], cwd?: string) =>
    sh("git", args, cwd === undefined ? {} : { cwd }).stdout.trim();
  const head = git(["rev-parse", "--verify", "--quiet", branch]);
  const ahead = Number(git(["rev-list", "--count", `${base}..${branch}`])) || 0;
  const worktree = worktrees.find((each) => each.branch === branch)?.path;
  const body =
    worktree && git(["rev-parse", "--path-format=absolute", "--git-path", PR_BODY], worktree);
  const report = head ? reportFile(runDir, number, head) : "";
  const findings =
    report && existsSync(report) ? findingsIn(readFileSync(report, "utf8")) : Number.NaN;
  const pr = prs.find((each) => each.headRefName === branch);
  return {
    number,
    branch,
    head,
    ahead,
    bodyFile: Boolean(body && existsSync(body)),
    comments,
    ...(Number.isInteger(findings) && { report: { findings } }),
    ...(pr && { pr: { url: pr.url, autoMerge: pr.autoMergeRequest !== null } }),
  };
}
