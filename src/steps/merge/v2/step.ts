import type { StepVersion } from "../../step.ts";

export const merge2: StepVersion = {
  name: "merge",
  version: 2,
  summary:
    "GitHub native: auto-merge lands each pull request once the base's required checks are green; the factory updates the ones behind and drops the ones that fail",
};
