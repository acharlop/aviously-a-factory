import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { readable, type StreamEvent, type Summary, summarize } from "./stream.ts";

/** A long command the runner starts and waits out: a Claude session, the queue, the nightly. */
export type Job = {
  /** Path prefix of its files: `<prefix>.log` (readable, appended) and `<prefix>.json` (the outcome); Claude's raw stream goes to `<prefix>.jsonl`. */
  prefix: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Minutes before it and everything it started are stopped; no cap when undefined. */
  capMinutes?: number;
  /** Its stdout is `claude -p --output-format stream-json`. */
  claude?: boolean;
};

export type Outcome = {
  exit: number;
  stopped?: NodeJS.Signals;
  timedOut?: true;
  summary?: Summary;
};

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export const logLine = (prefix: string, line: string) =>
  appendFileSync(`${prefix}.log`, `${new Date().toTimeString().slice(0, 8)} ${line}\n`);

/** Runs a job in its own process group, so a stop signal or the cap reaches everything it started. */
export function runJob(
  job: Job,
  // Under launchd's ExitTimeOut of 60 s, so the KILL lands before launchd's.
  killAfterMs = 30_000,
): Promise<Outcome> {
  const { prefix, command, args, capMinutes } = job;
  const log = (line: string) => logLine(prefix, line);
  const raw = job.claude ? createWriteStream(`${prefix}.jsonl`, { flags: "a" }) : undefined;
  const events: StreamEvent[] = [];
  const child = spawn(command, args, {
    cwd: job.cwd,
    env: job.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // The group is already gone.
    }
  };
  const groupAlive = () => {
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  let stopped: NodeJS.Signals | undefined;
  let timedOut = false;
  let killAt: number | undefined;
  const stop = (signal: NodeJS.Signals, why: string) => {
    log(`stopping ${command} and its process group: ${why}`);
    killAt ??= Date.now() + killAfterMs;
    killGroup(signal);
    setTimeout(() => {
      log(
        `${command}'s process group still running ${killAfterMs / 1000} s after ${signal}: SIGKILL`,
      );
      killGroup("SIGKILL");
    }, killAt - Date.now()).unref();
  };
  // Nothing else reaps what the job leaves behind: TERM it, then KILL by the stop's deadline.
  const reapGroup = () =>
    new Promise<void>((resolve) => {
      if (!groupAlive()) return resolve();
      log(`${command} exited with its process group still running: SIGTERM`);
      killAt ??= Date.now() + killAfterMs;
      killGroup("SIGTERM");
      const poll = setInterval(() => {
        if (groupAlive() && Date.now() < killAt!) return;
        if (groupAlive()) {
          log(`${command}'s process group still running at the kill deadline: SIGKILL`);
          killGroup("SIGKILL");
        }
        clearInterval(poll);
        resolve();
      }, 100);
    });
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = signal;
    stop(signal, signal);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  const cap =
    capMinutes !== undefined && capMinutes > 0
      ? setTimeout(() => {
          timedOut = true;
          stop("SIGTERM", `the cap, ${capMinutes} min`);
        }, capMinutes * 60_000)
      : undefined;

  createInterface({ input: child.stderr }).on("line", (line) => log(`stderr: ${line}`));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!raw) return log(line);
    raw.write(`${line}\n`);
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return log(`stdout: ${line}`);
    }
    events.push(event);
    for (const text of readable(event)) log(text);
  });

  return new Promise((resolve) => {
    let reaped = Promise.resolve();
    let finished = false;
    const finish = async (outcome: Outcome) => {
      if (finished) return;
      finished = true;
      if (cap) clearTimeout(cap);
      writeFileSync(`${prefix}.json`, JSON.stringify(outcome, null, 2));
      await reaped;
      for (const signal of SIGNALS) process.off(signal, onSignal);
      if (raw) raw.end(() => resolve(outcome));
      else resolve(outcome);
    };
    child.on("error", (error) => {
      log(`couldn't start ${command}: ${error.message}`);
      void finish({ exit: 127, ...(raw && { summary: summarize(events) }) });
    });
    // On exit, not close: a leftover holding the job's pipes would keep close from ever firing.
    child.on("exit", () => {
      reaped = reapGroup();
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      const exit = code ?? 128 + (signal === "SIGKILL" ? 9 : 15);
      const summary = raw ? summarize(events) : undefined;
      const outcome: Outcome = {
        exit,
        ...(stopped && { stopped }),
        ...(timedOut && { timedOut: true as const }),
        ...(summary && { summary }),
      };
      log(
        `exit ${exit}` +
          (summary
            ? `: ${summary.turns} turns, ${summary.tokens} tokens, ${summary.agents} agents`
            : "") +
          (summary?.limitResetsAt
            ? `, usage limit until ${new Date(summary.limitResetsAt * 1000).toString()}`
            : ""),
      );
      void finish(outcome);
    });
  });
}
