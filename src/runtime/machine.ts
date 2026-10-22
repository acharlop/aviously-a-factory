import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The machine config: KEY=value lines a shell runner sources as they are. `~/.factory/machine`
 * holds what is true for every project; `~/.factory/<project>/config` overrides it for one,
 * beside that project's `state`, marks and run folders.
 */
export const FACTORY_HOME = join(homedir(), ".factory");

/** Each step's default minutes; the keys are the ones yarcone's runner already writes. */
const TIMEOUTS = {
  TIMEOUT_CODER: 30,
  TIMEOUT_REVIEW: 15,
  TIMEOUT_FIX: 25,
  TIMEOUT_STRINGS: 15,
  TIMEOUT_VERIFY: 10,
  TIMEOUT_E2E: 20,
  TIMEOUT_QUEUE: 40,
  TIMEOUT_RUN: 150,
} as const;
export type Timeout = keyof typeof TIMEOUTS;
export const TIMEOUT_KEYS = Object.keys(TIMEOUTS) as [Timeout, ...Timeout[]];

export type MachineConfig = Record<string, string>;

export function parseSettings(text: string): MachineConfig {
  const settings: MachineConfig = {};
  for (const line of text.split("\n")) {
    const found = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!found) continue;
    const value = found[2]!.replace(/\s+#.*$/, "").trim();
    settings[found[1]!] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return settings;
}

const readSettings = (file: string) =>
  existsSync(file) ? parseSettings(readFileSync(file, "utf8")) : {};

/** Where this machine keeps one project's config, state, marks and run folders. */
export const projectHome = (project: string, home = FACTORY_HOME) => join(home, project);

/** The folder a shift on `date` (YYYY-MM-DD) keeps its notes and patches in when the runner names none. */
export const runFolder = (project: string, date: string, home = FACTORY_HOME) =>
  join(projectHome(project, home), "runs", date);

/** What is true for every project on this machine. */
export const machineWide = (home = FACTORY_HOME) => readSettings(join(home, "machine"));

/** The machine-wide settings, with the project's own on top. */
export const machineConfig = (project: string, home = FACTORY_HOME): MachineConfig => ({
  ...machineWide(home),
  ...readSettings(join(projectHome(project, home), "config")),
});

/** How many checks may run at once on this machine (`CHECK_SLOTS`), 2 by default. */
export function checkSlots(config: MachineConfig): number {
  const slots = Number(config.CHECK_SLOTS);
  return Number.isInteger(slots) && slots > 0 ? slots : 2;
}

export const queueOn = (config: MachineConfig) => config.QUEUE === "on";

/** The other machine that runs a merge queue (`QUEUE_PEER`), whose queue this one waits out; undefined when none. */
export const queuePeer = (config: MachineConfig) => config.QUEUE_PEER || undefined;

/** Whether this machine runs the mobile flows for the mobile check (`MOBILE_SIGNOFF=on`, the one with the simulator). */
export const mobileSignoff = (config: MachineConfig) => config.MOBILE_SIGNOFF === "on";

export function timeoutMinutes(config: MachineConfig, key: Timeout): number {
  const minutes = Number(config[key]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : TIMEOUTS[key];
}

/** The 1-minute load average the merge queue waits under before it starts (`LOAD_MAX`), twice the cores by default. */
export function loadMax(config: MachineConfig, cores = cpus().length): number {
  const max = Number(config.LOAD_MAX);
  return Number.isFinite(max) && max > 0 ? max : cores * 2;
}

/** This machine's shift counter for the project (`RUN_COUNT` in its state), bumped as each shift starts; 0 before the first. */
export function shiftCount(project: string, home = FACTORY_HOME): number {
  const count = Number(readSettings(join(projectHome(project, home), "state")).RUN_COUNT);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** Reads a KEY=value file, such as a project's `state`; empty when it isn't there. */
export const readState = readSettings;

/** Sets one key in a KEY=value file, keeping the others. */
export function writeState(file: string, key: string, value: string | number) {
  const kept = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() && !new RegExp(`^\\s*(?:export\\s+)?${key}=`).test(line))
    : [];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, [...kept, `${key}=${value}`, ""].join("\n"));
  renameSync(`${file}.new`, file);
}

/** Adds one to the project's shift count and returns it, as the runner does before a lights-out shift. */
export function bumpShiftCount(project: string, home = FACTORY_HOME): number {
  const count = shiftCount(project, home) + 1;
  writeState(join(projectHome(project, home), "state"), "RUN_COUNT", count);
  return count;
}

/** The runner's own folder: its log, lock, rota state and stopping flag. */
export const runnerHome = (home = FACTORY_HOME) => join(home, "runner");

/** The projects this machine serves (`PROJECTS` in `~/.factory/machine`), in the order the rota visits them. */
export const servedProjects = (home = FACTORY_HOME) =>
  (readSettings(join(home, "machine")).PROJECTS ?? "").split(/[\s,]+/).filter(Boolean);

/** The project's checkout on this machine (`CHECKOUT`), with a leading `~` or `$HOME` expanded. */
export const checkoutOf = (config: MachineConfig, user = homedir()) =>
  config.CHECKOUT?.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, user) || undefined;

/** Whether the runner works lights-out shifts on the project here (`UNATTENDED`, on unless set to off). */
export const unattended = (config: MachineConfig) => config.UNATTENDED !== "off";
