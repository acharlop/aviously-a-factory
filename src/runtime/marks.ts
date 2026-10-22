import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FACTORY_HOME, projectHome } from "./machine.ts";

/** The timed steps; `run` is a whole shift, the name yarcone's `factory:timings` writes. */
export const STEPS = ["queue", "run"] as const;
export type Step = (typeof STEPS)[number];

export type Mark = { step: Step; event: "start" | "end"; at: string; key?: string };

/** The project's start and end marks on this machine, one JSON line each. */
export const marksFile = (project: string, home = FACTORY_HOME) =>
  join(projectHome(project, home), "timings.jsonl");

export const readMarks = (file: string): Mark[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Mark)
    : [];

/** Each step's finished durations in minutes: an end pairs with the latest start of its step and key. */
export function durations(marks: readonly Mark[]): Map<Step, number[]> {
  const open = new Map<string, number>();
  const done = new Map<Step, number[]>();
  for (const { step, event, at, key = "" } of marks) {
    if (!STEPS.includes(step)) continue;
    const id = `${step} ${key}`;
    if (event === "start") open.set(id, Date.parse(at));
    else {
      const started = open.get(id);
      if (started === undefined) continue;
      open.delete(id);
      done.set(step, [...(done.get(step) ?? []), (Date.parse(at) - started) / 60_000]);
    }
  }
  return done;
}

export function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return undefined;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Each step's median minutes, under their header. */
export function stepMedians(marks: readonly Mark[]): string[] {
  const found = durations(marks);
  return [
    "# step\tmedian minutes\truns",
    ...STEPS.map((step) => {
      const runs = found.get(step) ?? [];
      const typical = median(runs);
      return `${step}\t${typical === undefined ? "-" : typical.toFixed(1)}\t${runs.length} runs`;
    }),
  ];
}
