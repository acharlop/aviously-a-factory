import type { StepVersion } from "../../step.ts";

export const gate1: StepVersion = {
  name: "gate",
  version: 1,
  summary:
    "Runs the project's checks on a branch on this machine, then pushes it and posts each check's status",
};
