import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadProject, type Resolved } from "../config/load.ts";
import type { Merge } from "../config/schema.ts";
import { findModule } from "../modules/registry.ts";
import { projectChecks } from "../runtime/checks.ts";
import { exec } from "../runtime/exec.ts";
import { ghJson, repoName } from "../runtime/github.ts";
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
import { reviewBlockers } from "../runtime/reviews.ts";
import { runLockOf, withRunLock } from "../runtime/run-lock.ts";
import { stepLogs, stopOnSignal } from "../runtime/run.ts";
import { signOffRecorder } from "../steps/file/v1/sign-off.ts";
import { commandFixup, ensureClone, queueCheckout } from "../steps/merge/v1/checkout.ts";
import { blockers, stayAwake, waitForLoad } from "../steps/merge/v1/host.ts";
import { holdQueue, peerDeps } from "../steps/merge/v1/peer.ts";
import { preview } from "../steps/merge/v1/preview.ts";
import { newRound, type Round, runQueue, summarize } from "../steps/merge/v1/queue.ts";
import {
  dropComment,
  earlierQueued,
  type NativePr,
  PR_FIELDS,
  tend,
} from "../steps/merge/v2/native.ts";
import { requiredChecks } from "../steps/merge/v2/required.ts";
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

/** merge@2's pass: GitHub lands what has auto-merge on, so it needs no lock, no clone and no queue machine. */
function nativePass(
  { gate, merge }: Resolved,
  options: NonNullable<ReturnType<typeof parseArgs>>,
  log: (line: string) => void,
): number {
  if (options.all) queueAll(gate.base, merge.method, log);
  const logFile = options.runDir && join(options.runDir, "queue.log");
  const earlier = earlierQueued(
    logFile && existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
  );
  return tend({
    base: gate.base,
    log,
    open: () =>
      ghJson<NativePr[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--base",
        gate.base,
        "--limit",
        "200",
        "--json",
        PR_FIELDS,
      ]),
    required: requiredChecks(gate.base),
    reviews: (pr) => reviewBlockers(pr.number),
    update: (pr) => {
      const how = merge.method === "rebase" ? ["--rebase"] : [];
      const updated = exec("gh", ["pr", "update-branch", String(pr.number), ...how]);
      return updated.status === 0 ? undefined : updated.stderr.trim();
    },
    drop: (pr, reason) => {
      for (const args of [
        ["pr", "merge", String(pr.number), "--disable-auto"],
        ["pr", "comment", String(pr.number), "--body-file", "-"],
      ]) {
        const result = exec("gh", args, { input: dropComment(reason) });
        if (result.status !== 0)
          log(`merge-queue: gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
      }
    },
    earlier,
    merged: (number) =>
      exec("gh", [
        "pr",
        "view",
        String(number),
        "--json",
        "state",
        "--jq",
        ".state",
      ]).stdout.trim() === "MERGED",
    dryRun: options.dryRun,
  });
}

/** `factory queue`: the merge step. merge@1 is the queue on this machine: it lands every open pull request into the base with auto-merge on, gated on this machine. merge@2 is a pass over what GitHub lands. */
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
  const pin = resolved.steps.merge;
  if (typeof pin === "object" && "version" in pin && pin.version === 2)
    return nativePass(resolved, options, log);
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
