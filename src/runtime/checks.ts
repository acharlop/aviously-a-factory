import { matchesGlob } from "node:path";

import type { Gate } from "../config/schema.ts";
import { findModule, type ModuleContext } from "../modules/registry.ts";
import type { Exec } from "./exec.ts";
import type { Timeout } from "./machine.ts";
import type { Runner } from "./run.ts";

/** A change a check is asked about: the checkout at its head, the base it is measured from, and the files it changes (undefined when git can't say). */
export type Change = {
  dir: string;
  base: string;
  head: string;
  files: readonly string[] | undefined;
};

/** What a change needs from a check: the units it selected (spec files, flows), none for a check that runs whole; undefined when it needs no run. */
export type Need = { units: readonly string[] } | undefined;

/** A run's verdict: the units that failed (the check's own name for one that runs whole) and those it never got to; or why it couldn't run at all. */
export type Verdict =
  | { failed: readonly string[]; notRun?: readonly string[] }
  | { unavailable: string };

/** One run of a check on one commit, checked out at dir. */
export type CheckRun = {
  dir: string;
  base: string;
  sha: string;
  units: readonly string[];
  /** 0 for the first run, then each rerun of what failed. */
  attempt: number;
  logFile: string;
  timeoutMs: number;
  run: Runner;
  log: (line: string) => void;
};

/** One verdict the gate reports on a change, such as web or mobile: a command from factory.config.ts, or one a module supplies. */
export type Check = {
  name: string;
  /** What runs, as logs and sign-offs name it. */
  command: string;
  /** The machine config key whose minutes bound one run. */
  timeout: Timeout;
  /** Runs a unit gets before it counts as failed; a unit that fails and then passes is flaky. */
  tries: number;
  /** Whether a pass is kept per commit in the checkout's git directory, so the same code never runs it twice. */
  marker: boolean;
  needs: (change: Change) => Promise<Need | { refused: string }>;
  /** Why this machine can't run it, so a change that needs it waits for one that can; undefined when it can. */
  unavailable?: () => string | undefined;
  run: (at: CheckRun) => Promise<Verdict>;
  /** The passed status's description, from the units the change selected; the caller's own when undefined. */
  describe?: (units: readonly string[]) => string | undefined;
  /** Told about units that failed once and passed on a rerun, with the pull requests that selected each. */
  flaky?: (flakes: readonly { unit: string; prs: readonly number[] }[]) => void;
};

/** Whether a path matches globs, where a glob starting with `!` excludes what it matches. */
export function matches(path: string, globs: readonly string[]): boolean {
  const excluded = globs.some((glob) => glob.startsWith("!") && matchesGlob(path, glob.slice(1)));
  return !excluded && globs.some((glob) => !glob.startsWith("!") && matchesGlob(path, glob));
}

/** Whether files touch only docs, which need no check; an empty or unreadable list isn't docs only. */
export const docsOnly = (files: readonly string[] | undefined, docs: readonly string[]) =>
  files !== undefined && files.length > 0 && files.every((file) => matches(file, docs));

/** Whether the files reach the check's `when` globs; files git couldn't read reach every check. */
export const reaches = (
  files: readonly string[] | undefined,
  when: readonly string[] | undefined,
) => !files || !when || files.some((file) => matches(file, when));

/** The checks a change needs, by its files alone: none for docs, each check whose `when` its files reach. */
export const checksFor = (gate: Gate, files: readonly string[] | undefined): string[] =>
  docsOnly(files, gate.docs)
    ? []
    : Object.entries(gate.checks)
        .filter(([, check]) => reaches(files, check.when))
        .map(([name]) => name);

/** The files base...head changes, or this checkout since base when there's no head (untracked included); undefined when git can't say. */
export function changedFiles(
  base: string,
  head: string | undefined,
  sh: Exec,
  cwd?: string,
): string[] | undefined {
  const diff = sh(
    "git",
    head
      ? ["diff", "--name-only", "--no-renames", `${base}...${head}`]
      : ["diff", "--name-only", "--no-renames", "--merge-base", base],
    { cwd },
  );
  if (diff.status !== 0) return undefined;
  const files = diff.stdout.split("\n").filter(Boolean);
  if (!head) {
    const others = sh("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    if (others.status === 0) files.push(...others.stdout.split("\n").filter(Boolean));
  }
  return files;
}

/** Runs a configured command through sh, with args after it. */
export const shell = (command: string, args: readonly string[]) => [
  "sh",
  "-c",
  `${command} "$@"`,
  "sh",
  ...args,
];

type CommandConfig = Extract<Gate["checks"][string], { run: string }>;

/** A check factory.config.ts runs as a command: its `select` command, given the base, prints the units it needs, which the run gets as arguments. */
export function commandCheck(name: string, config: CommandConfig, sh: Exec): Check {
  const { run, select, timeout, tries } = config;
  return {
    name,
    command: run,
    timeout,
    tries,
    marker: select === undefined,
    needs: async ({ dir, base, files }) => {
      if (!reaches(files, config.when)) return undefined;
      if (select === undefined) return { units: [] };
      const [program = "", ...args] = shell(select, [base]);
      const selected = sh(program, args, { cwd: dir });
      if (selected.status !== 0)
        return { refused: `selecting what ${name} runs failed: ${selected.stderr.trim()}` };
      const units = selected.stdout.split("\n").filter(Boolean);
      return units.length > 0 ? { units } : undefined;
    },
    run: async (at) => {
      const { passed, timedOut } = await at.run(
        shell(run, at.units),
        at.logFile,
        at.dir,
        at.timeoutMs,
      );
      if (timedOut)
        at.log(
          `\`${run}\` ran past ${timeout} (${at.timeoutMs / 60_000} min); counting it as failed`,
        );
      return { failed: passed ? [] : at.units.length > 0 ? at.units : [name] };
    },
  };
}

/** The project's checks, in the order factory.config.ts lists them. */
export const projectChecks = (gate: Gate, context: ModuleContext): Check[] =>
  Object.entries(gate.checks).map(([name, config]) => {
    if ("run" in config) return commandCheck(name, config, context.sh);
    const supplied = findModule(config.module)!.check!(name, context);
    return config.when ? { ...supplied, needs: whenFirst(config.when, supplied) } : supplied;
  });

/** A module check's needs, asked only when the change reaches the `when` globs the project gave it. */
const whenFirst =
  (when: readonly string[], check: Check): Check["needs"] =>
  async (change) =>
    reaches(change.files, when) ? check.needs(change) : undefined;
