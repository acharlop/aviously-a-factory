import type { StepVersion } from "../../step.ts";

export const merge1: StepVersion = {
  name: "merge",
  version: 1,
  summary:
    "The Mac queue: batches the pull requests with auto-merge on, runs the gate's checks on them together on this machine, and merges what passes",
};
