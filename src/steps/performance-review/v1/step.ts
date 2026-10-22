import type { StepVersion } from "../../step.ts";

export const performanceReview1: StepVersion = {
  name: "performance-review",
  version: 1,
  summary:
    "HR reads the suggestion box and the timesheets since the last review and opens handbook PRs, to the factory or the project",
  agent: "hr",
};

/** Hours after a review before the next is due: once a day, with slack for when a shift ends. */
export const WINDOW_HOURS = 20;

/** `due`, or why not: the last review's time, when it fell inside the window. */
export function reviewDue(lastAt: string | undefined, now: number): string {
  if (lastAt === undefined || Date.parse(lastAt) < now - WINDOW_HOURS * 3_600_000) return "due";
  const hours = Math.floor((now - Date.parse(lastAt)) / 3_600_000);
  return `not due: the last performance review was at ${lastAt} (${hours} h ago)`;
}
