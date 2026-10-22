import { join, matchesGlob } from "node:path";

import type { Resolved } from "../../../config/load.ts";
import { reviewedAt, type TicketState } from "../../../runtime/ticket.ts";
import type { StepVersion } from "../../step.ts";

export const qualityControl1: StepVersion = {
  name: "quality-control",
  version: 1,
  summary:
    "Inspectors judge the built branch, one per axis: spec and standards always, security and looks when the change reaches them",
};

/** The inspectors on each axis, each a plugin agent; looks needs the screenshots module. */
export const INSPECTORS = {
  spec: "spec-inspector",
  standards: "standards-inspector",
  security: "security-inspector",
  looks: "looks-inspector",
} as const;
export type Axis = keyof typeof INSPECTORS;

/**
 * The axes a branch changing `files` is inspected on, each with why. Looks is listed whenever the
 * screenshots module is on: only the foreman can tell a change that alters what a screen renders.
 */
export function axesFor(
  files: readonly string[],
  resolved: Resolved,
): { axis: Axis; why: string }[] {
  const { security } = resolved.foreman;
  const touched = files.filter((file) => security.some((glob) => matchesGlob(file, glob)));
  return [
    { axis: "spec", why: "always" },
    { axis: "standards", why: "always" },
    ...(touched.length > 0
      ? [{ axis: "security" as const, why: `touches ${touched.join(", ")}` }]
      : []),
    ...(resolved.modules.screenshots === "none"
      ? []
      : [
          { axis: "looks" as const, why: "the screenshots module is on: skip it for no UI change" },
        ]),
  ];
}

/** Where the foreman writes quality control's confirmed findings on one head. */
export const reportFile = (runDir: string, number: number, head: string) =>
  join(runDir, `${number}-quality-control-${head.slice(0, 12)}.md`);

/** The confirmed findings a report counts on its `Findings: <k>` first line. */
export const findingsIn = (report: string) =>
  Number(/^Findings: (\d+)/.exec(report.trimStart())?.[1] ?? Number.NaN);

/** Inspected once the head has a report in the run folder, or passed before. */
export const inspected = (state: TicketState) =>
  state.report !== undefined || reviewedAt(state.comments, state.head);
