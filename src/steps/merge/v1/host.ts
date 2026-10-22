import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname } from "node:path";

import { exec, type Exec } from "../../../runtime/exec.ts";

const MIN_FREE_GB = 8;

/** What stops a run on this machine: a command the project needs failing, a full disk, gh signed out. */
export function blockers(dir: string, needs: readonly string[], sh: Exec = exec): string[] {
  const found = needs
    .filter((command) => sh("sh", ["-c", command]).status !== 0)
    .map((command) => `\`${command}\` failed, and the project's checks need it`);
  const disk = statfsSync(existsSync(dir) ? dir : dirname(dir));
  const freeGb = Math.floor((disk.bavail * disk.bsize) / 2 ** 30);
  // A full build needs a few GB; a full disk turns Docker read-only mid-run.
  if (freeGb < MIN_FREE_GB) found.push(`only ${freeGb} GB free, and a run needs ${MIN_FREE_GB}`);
  if (sh("gh", ["auth", "status"]).status !== 0) found.push("gh isn't signed in; gh auth login");
  return found;
}

type LoadDeps = {
  load: () => number;
  everyMs: number;
  limitMs: number;
  sleep: (ms: number) => Promise<void>;
};

/** Waits until the 1-minute load average is under max, since checks on a loaded machine flake and time out; gives up after the limit and goes on. */
export async function waitForLoad(
  max: number,
  log: (line: string) => void,
  deps: Partial<LoadDeps> = {},
): Promise<void> {
  const {
    load = () => loadavg()[0]!,
    everyMs = 30_000,
    limitMs = 20 * 60_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  const first = load();
  if (first < max) return;
  log(`merge-queue: load ${first.toFixed(1)} is over LOAD_MAX ${max}; waiting for it to drop`);
  for (let waited = 0; waited < limitMs; waited += everyMs) {
    await sleep(everyMs);
    const now = load();
    if (now < max) {
      log(`merge-queue: load ${now.toFixed(1)} after ${Math.round(waited / 60_000)} min; starting`);
      return;
    }
  }
  log(`merge-queue: load ${load().toFixed(1)} after ${limitMs / 60_000} min; starting anyway`);
}

type Start = (command: string, args: string[]) => ChildProcess;

/** Holds a no-sleep assertion on macOS while this process lives, since a machine that sleeps mid-run times its checks out; the release. */
export function stayAwake(
  log: (line: string) => void,
  platform: NodeJS.Platform = process.platform,
  start: Start = (command, args) => spawn(command, args, { stdio: "ignore" }),
): () => void {
  if (platform !== "darwin") return () => {};
  // -w ends it with this process, even when it's killed past any cleanup.
  const caffeinate = start("caffeinate", ["-dimsu", "-w", String(process.pid)]);
  caffeinate.on("error", (error) =>
    log(`merge-queue: couldn't hold a no-sleep assertion: ${error.message}`),
  );
  caffeinate.unref();
  log("merge-queue: holding a no-sleep assertion (caffeinate -dimsu) for this run");
  return () => caffeinate.kill();
}
