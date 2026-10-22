import { existsSync, readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";

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

/** The machine-wide settings, with the project's own on top. */
export const machineConfig = (project: string, home = FACTORY_HOME): MachineConfig => ({
  ...readSettings(join(home, "machine")),
  ...readSettings(join(projectHome(project, home), "config")),
});

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
