import { file1 } from "./file/v1/step.ts";
import { realityCheck1 } from "./reality-check/v1/step.ts";
import type { StepVersion } from "./step.ts";
import { triage1 } from "./triage/v1/step.ts";
import { claim1 } from "./claim/v1/step.ts";
import { build1 } from "./build/v1/step.ts";
import { qualityControl1 } from "./quality-control/v1/step.ts";
import { rework1 } from "./rework/v1/step.ts";
import { performanceReview1 } from "./performance-review/v1/step.ts";

/** Every step version this release ships, side by side (ADR 0001). Each lives in steps/<name>/v<N>. */
export const STEP_VERSIONS: readonly StepVersion[] = [
  file1,
  realityCheck1,
  triage1,
  claim1,
  build1,
  qualityControl1,
  rework1,
  performanceReview1,
];

export const findStep = (name: string, version: number, versions = STEP_VERSIONS) =>
  versions.find((step) => step.name === name && step.version === version);

export const stepNames = (versions = STEP_VERSIONS) =>
  [...new Set(versions.map((step) => step.name))].sort();
