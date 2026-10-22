import { file1 } from "./file/v1/step.ts";
import { realityCheck1 } from "./reality-check/v1/step.ts";
import type { StepVersion } from "./step.ts";
import { triage1 } from "./triage/v1/step.ts";

/** Every step version this release ships, side by side (ADR 0001). Each lives in steps/<name>/v<N>. */
export const STEP_VERSIONS: readonly StepVersion[] = [file1, realityCheck1, triage1];

export const findStep = (name: string, version: number, versions = STEP_VERSIONS) =>
  versions.find((step) => step.name === name && step.version === version);

export const stepNames = (versions = STEP_VERSIONS) =>
  [...new Set(versions.map((step) => step.name))].sort();
