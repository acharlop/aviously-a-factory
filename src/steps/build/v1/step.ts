import type { TicketState } from "../../../runtime/ticket.ts";
import type { StepVersion } from "../../step.ts";

export const build1: StepVersion = {
  name: "build",
  version: 1,
  summary:
    "A fresh temp builds the claimed ticket in its own worktree, with tests, as local commits and a PR body file",
  agent: "temp",
};

/** Where the temp writes the branch's PR body, in the worktree's git dir so it is never committed. */
export const PR_BODY = "factory-pr-body.md";

/** Built once the branch has a commit past main and the PR body the temp wrote. */
export const built = (state: TicketState) => state.ahead > 0 && state.bodyFile;
