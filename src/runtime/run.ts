import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";

import { signalGroup } from "./lock.ts";

/** Runs a command with its output in logFile; passed when it exits 0 before any timeout. */
export function runLogged(
  command: readonly string[],
  logFile: string,
  cwd?: string,
  track?: (child: ChildProcess) => void,
  timeoutMs?: number,
): Promise<{ passed: boolean; timedOut: boolean }> {
  const out = openSync(logFile, "w");
  const [program = "", ...args] = command;
  // A tracked child leads its own process group, so the tracker's signal reaches what it starts and the terminal's doesn't reach it twice.
  const child = spawn(program, args, {
    cwd,
    stdio: ["ignore", out, out],
    detached: track !== undefined,
  });
  closeSync(out);
  track?.(child);
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          if (track) signalGroup(child, "SIGTERM");
          else child.kill("SIGTERM");
        }, timeoutMs);
  return new Promise((resolve) => {
    const done = (passed: boolean) => {
      clearTimeout(timer);
      resolve({ passed: passed && !timedOut, timedOut });
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

/** Runs one command to the end with its output in a log file. */
export type Runner = (
  command: readonly string[],
  logFile: string,
  cwd?: string,
  timeoutMs?: number,
) => Promise<{ passed: boolean; timedOut: boolean }>;

/** Long commands under a lock: a signal goes on to the running one and everything it started, the next never starts, and the lock is released once that one exits. */
export function stopOnSignal(
  release: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
) {
  const children = new Set<ChildProcess>();
  let stopped: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals) => {
    stopped = signal;
    if (children.size === 0) {
      release();
      exit(128 + constants.signals[signal]);
    }
    for (const child of children) signalGroup(child, signal);
  };
  const track = (child: ChildProcess) => {
    children.add(child);
    child.once("close", () => {
      children.delete(child);
      if (stopped && children.size === 0) release();
    });
  };
  // Thrown rather than returned, so a stopped command never reads as a failed check that drops a pull request.
  const check = () => {
    if (stopped) throw new Error(`stopped by ${stopped}`);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const run: Runner = async (command, logFile, cwd, timeoutMs) => {
    check();
    const result = await runLogged(command, logFile, cwd, track, timeoutMs);
    check();
    return result;
  };
  return {
    run,
    stop,
    stopped: () => stopped,
    dispose: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}
