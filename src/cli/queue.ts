import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadProject } from "../config/load.ts";
import type { Merge } from "../config/schema.ts";
import { findModule } from "../modules/registry.ts";
import { projectChecks } from "../runtime/checks.ts";
import { exec } from "../runtime/exec.ts";
import { repoName } from "../runtime/github.ts";
import { describeOwner, HEAVY_LOCK, holdLock, lockOwner } from "../runtime/lock.ts";
import {
  FACTORY_HOME,
  loadMax,
  machineConfig,
  projectHome,
  queueOn,
  queuePeer,
  timeoutMinutes,
} from "../runtime/machine.ts";
import { runLockOf, withRunLock } from "../runtime/run-lock.ts";
import { stepLogs, stopOnSignal } from "../runtime/run.ts";
import { signOffRecorder } from "../steps/file/v1/sign-off.ts";
import { commandFixup, ensureClone, queueCheckout } from "../steps/merge/v1/checkout.ts";
import { blockers, stayAwake, waitForLoad } from "../steps/merge/v1/host.ts";
import { holdQueue, peerDeps } from "../steps/merge/v1/peer.ts";
import { preview } from "../steps/merge/v1/preview.ts";
import { newRound, type Round, runQueue, summarize } from "../steps/merge/v1/queue.ts";
import { skipped } from "./gate.ts";

const USAGE = "usage: factory queue [--all] [--dry-run] [--checkout <path>] [--run-dir <path>]";

/** The run's options, or undefined when they don't parse; the run folder is `--run-dir`, else FACTORY_RUN_DIR. */
export function parseArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? { at } : { at, value: args[at + 1] };
  };
  const checkout = valueOf("--checkout");
  const runDir = valueOf("--run-dir");
  const values = [checkout, runDir].filter(({ at }) => at >= 0).map(({ value }) => value);
  const known = new Set(["--all", "--dry-run", "--checkout", "--run-dir", ...values]);
  if (args.some((arg) => !known.has(arg)) || values.some((value) => !value)) return undefined;
  const folder = runDir.value ?? env.FACTORY_RUN_DIR;
  return {
    all: args.includes("--all"),
    dryRun: args.includes("--dry-run"),
    checkout: checkout.value && resolve(checkout.value),
    runDir: folder ? resolve(folder) : undefined,
  };
}

/** Prints each line, and keeps it with its time in the shift's queue.log when there is a run folder. */
function queueLog(runDir: string | undefined) {
  if (!runDir) return (line: string) => console.log(line);
  mkdirSync(runDir, { recursive: true });
  return (line: string) => {
    console.log(line);
    appendFileSync(join(runDir, "queue.log"), `${new Date().toISOString()} ${line}\n`);
  };
}

/** Turns auto-merge on for every open, non-draft pull request into base that doesn't have it. */
function queueAll(base: string, method: Merge["method"], log: (line: string) => void): void {
  const listed = exec("gh", [
    "pr",
    "list",
    "--base",
    base,
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number,isDraft,autoMergeRequest",
    "--jq",
    ".[] | select((.isDraft | not) and .autoMergeRequest == null) | .number",
  ]);
  if (listed.status !== 0) throw new Error(`gh pr list failed: ${listed.stderr.trim()}`);
  const prs = listed.stdout.split("\n").filter(Boolean);
  const failed = prs.filter(
    (pr) => exec("gh", ["pr", "merge", pr, "--auto", `--${method}`]).status !== 0,
  );
  if (failed.length > 0)
    log(`merge-queue: couldn't turn auto-merge on for ${failed.map((n) => `#${n}`).join(", ")}`);
}

/** `factory queue`: merge@1, the queue on this machine. Lands every open pull request into the base with auto-merge on, gated on this machine. */
export async function queue(args: string[]): Promise<number> {
  const options = parseArgs(args);
  if (!options) {
    console.log(USAGE);
    return 2;
  }
  const log = queueLog(options.runDir);
  const resolved = await loadProject();
  const skip = skipped(resolved, "merge");
  if (skip) {
    log(`merge-queue: ${skip}`);
    return 0;
  }
  const { root, gate, merge, modules } = resolved;
  const project = repoName(exec).split("/")[1]!;
  const home = projectHome(project);
  const machine = machineConfig(project);
  if (options.all) queueAll(gate.base, merge.method, log);
  if (!options.dryRun && !queueOn(machine)) {
    log(
      `merge-queue: skipped: this machine runs the queue only with QUEUE=on in ${FACTORY_HOME}/machine or ${home}/config`,
    );
    return 0;
  }
  const commonDir = exec("git", ["rev-parse", "--git-common-dir"], { cwd: root }).stdout.trim();
  const main = dirname(resolve(root, commonDir));
  const dir = options.checkout ?? `${main}-merge-queue`;
  const holder = lockOwner(HEAVY_LOCK);
  log(
    `merge-queue: heavy lock ${HEAVY_LOCK}: ${holder ? `held by ${describeOwner(holder)}` : "free"}`,
  );
  log(
    `merge-queue: queue checkout ${dir}${existsSync(join(dir, ".git")) ? "" : " (not cloned yet)"}`,
  );
  const blocked = blockers(dir, merge.needs);
  for (const line of blocked) log(`merge-queue: ${line}`);
  let release = () => {};
  let awake = () => {};
  let guard: ReturnType<typeof stopOnSignal> | undefined;
  let round: Round | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (options.dryRun) {
      preview(root, gate, merge, log);
      return 0;
    }
    if (blocked.length > 0) return 1;
    await waitForLoad(loadMax(machine), log);
    awake = stayAwake(log);
    const stopper = (guard = stopOnSignal(
      () => release(),
      (code) => {
        if (round) summarize(round);
        process.exit(code);
      },
    ));
    const minutes = timeoutMinutes(machine, "TIMEOUT_QUEUE");
    await holdQueue(
      queuePeer(machine),
      async () =>
        withRunLock("queue", runLockOf(home), await holdLock(HEAVY_LOCK, "factory queue", dir)),
      (held) => (release = held),
      peerDeps(log, minutes * 60_000, join(home, "queue")),
    );
    timer = setTimeout(() => {
      log(`merge-queue: the queue ran past TIMEOUT_QUEUE (${minutes} min); stopping it`);
      stopper.stop("SIGTERM");
    }, minutes * 60_000);
    ensureClone(dir, main, merge.links, exec, log);
    const context = { root: dir, modules, machine, home, sh: exec };
    const deps = queueCheckout({
      dir,
      runDir: stepLogs(options.runDir, "factory-merge-queue-"),
      checkLogs: options.runDir,
      checks: projectChecks(gate, context),
      gate,
      merge,
      fixups: merge.fixups.map((fixup) =>
        typeof fixup === "string"
          ? commandFixup(fixup, exec)
          : findModule(fixup.module)!.fixup!(context),
      ),
      machine,
      record: await signOffRecorder(new Map(), (line) => log(`merge-queue: ${line}`), root),
      log,
      run: guard.run,
    });
    return await runQueue(deps, (round = newRound(deps)));
  } catch (error) {
    log(`merge-queue: stopped: ${(error as Error).message}`);
    const signal = guard?.stopped();
    return signal ? 128 + constants.signals[signal] : 1;
  } finally {
    clearTimeout(timer);
    guard?.dispose();
    release();
    awake();
  }
}
