import type { StepVersion } from "../../step.ts";

export const claim1: StepVersion = {
  name: "claim",
  version: 1,
  summary:
    "Takes the next free ticket the shift's filter admits, in its order, and claims it: assignee, in-progress and a comment naming the branch",
};

/** The label a claimed ticket carries until it merges or is given back. */
export const IN_PROGRESS = "in-progress";
