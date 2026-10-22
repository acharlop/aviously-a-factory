import type { Resolved } from "../../../config/load.ts";
import type { PaperTrail } from "../../../config/schema.ts";
import { exec, type Exec } from "../../../runtime/exec.ts";
import { machine, person, repoName } from "../../../runtime/github.ts";
import { FACTORY_HOME } from "../../../runtime/machine.ts";
import { file1 } from "./step.ts";

/** What every record notes: who filed it, from which machine, and with which factory. */
export type Stamp = {
  person: string;
  machine: string;
  /** The step version that wrote the record, e.g. file@1. */
  step: string;
  /** The factory release. */
  factory: string;
  /** Every step the project runs, as name@version, name@local or left out for none. */
  steps: string[];
};

export const stepPins = (steps: Resolved["steps"]) =>
  Object.entries(steps).flatMap(([name, step]) =>
    step === "none" ? [] : [`${name}@${"local" in step ? "local" : step.version}`],
  );

export const stamp = (person: string, machine: string, resolved: Resolved): Stamp => ({
  person,
  machine,
  step: `${file1.name}@${file1.version}`,
  factory: resolved.factoryVersion,
  steps: stepPins(resolved.steps),
});

/** Everything a record needs to be filed: the destination, the project's own repo and name, the factory home, the stamp and gh. */
export type Filing = {
  trail: PaperTrail;
  repo: string;
  project: string;
  home: string;
  stamp: Stamp;
  sh: Exec;
};

/** Where and as whom this machine files the project's records, or why it files none. */
export function filing(resolved: Resolved, sh: Exec = exec, home = FACTORY_HOME): Filing | string {
  const pin = resolved.steps.file;
  if (!pin || pin === "none") return "the file step is none in factory.config.ts; nothing filed";
  if ("local" in pin) return `the file step is local (${pin.local}); run it instead`;
  if (resolved.paperTrail === "none")
    return "paperTrail is none in factory.config.ts; nothing filed";
  const repo = repoName(sh);
  return {
    trail: resolved.paperTrail,
    repo,
    project: repo.split("/")[1]!,
    home,
    stamp: stamp(person(sh), machine(), resolved),
    sh,
  };
}

/** The modes; yarcone's careful, autopilot and conductor stay accepted until its foreman moves. */
export const MODES = [
  "supervised",
  "unsupervised",
  "lights-out",
  "careful",
  "autopilot",
  "conductor",
] as const;
export type Mode = (typeof MODES)[number];

/** The mode a shift's invocation names; supervised when it names none. */
export const modeIn = (invocation: string): Mode =>
  MODES.find((mode) => new RegExp(`(?<![\\w-])${mode}(?![\\w-])`).test(invocation)) ?? "supervised";

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
export const localTime = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;
