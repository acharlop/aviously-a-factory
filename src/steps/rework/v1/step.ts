import { reviewedAt, type TicketState } from "../../../runtime/ticket.ts";
import type { StepVersion } from "../../step.ts";

export const rework1: StepVersion = {
  name: "rework",
  version: 1,
  summary:
    "One fresh temp fixes what quality control confirmed, once per change, then the branch is pushed with its PR and Reviewed at its head",
  agent: "temp",
};

/** Reworked once the head is Reviewed, or quality control found nothing to fix. */
export const reworked = (state: TicketState) =>
  reviewedAt(state.comments, state.head) || state.report?.findings === 0;
