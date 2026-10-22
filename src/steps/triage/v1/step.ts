import type { StepVersion } from "../../step.ts";

export const triage1: StepVersion = {
  name: "triage",
  version: 1,
  summary: "The receptionist gives each untriaged ticket one route, a kind and its department",
  agent: "receptionist",
};

/** A triaged ticket has exactly one of these. */
export const ROUTES = [
  "ready-for-agent",
  "decision needed",
  "ready-for-human",
  "to-discuss",
  "blocked",
  "Parked",
] as const;

export type Listed = { number: number; title: string; labels: { name: string }[] };

const NOT_ROUTED: readonly string[] = ["epic", "odd jobs", ...ROUTES];

/** Open tickets with no route that aren't epics or odd jobs, oldest first. */
export const untriaged = (issues: readonly Listed[]) =>
  issues
    .filter(({ labels }) => labels.every(({ name }) => !NOT_ROUTED.includes(name)))
    .sort((a, b) => a.number - b.number);
