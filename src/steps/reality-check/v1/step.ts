import type { StepVersion } from "../../step.ts";

export const realityCheck1: StepVersion = {
  name: "reality-check",
  version: 1,
  summary: "A read-only agent checks a ready ticket's claims against main before anyone claims it",
  agent: "reality-check",
};
