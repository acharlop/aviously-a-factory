import type { StepVersion } from "./step.ts";

/** Every step version this release ships, side by side (ADR 0001). Each lives in steps/<name>/v<N>. */
export const STEP_VERSIONS: readonly StepVersion[] = [];

export const findStep = (name: string, version: number, versions = STEP_VERSIONS) =>
  versions.find((step) => step.name === name && step.version === version);

export const stepNames = (versions = STEP_VERSIONS) =>
  [...new Set(versions.map((step) => step.name))].sort();
