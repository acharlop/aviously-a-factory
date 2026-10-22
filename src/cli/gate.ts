import { mkdtempSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

import { loadProject, type Resolved } from "../config/load.ts";
import { changedFiles, checksFor, projectChecks } from "../runtime/checks.ts";
import { exec } from "../runtime/exec.ts";
import { repoName } from "../runtime/github.ts";
import { HEAVY_LOCK, holdCheckSlot, holdLock, runHeavy } from "../runtime/lock.ts";
import { machineConfig, timeoutMinutes } from "../runtime/machine.ts";
import { gitMarkers, markerOf, passCovering } from "../runtime/markers.ts";
import { stopOnSignal } from "../runtime/run.ts";
import { type CheckStats, sampleUsage, signOffRecorder } from "../steps/file/v1/sign-off.ts";
import { signOff } from "../steps/gate/v1/sign-off.ts";

/** Why the project doesn't run this factory step here, or undefined when it does. */
export function skipped(resolved: Resolved, step: string): string | undefined {
  const pin = resolved.steps[step];
  if (!pin || pin === "none") return `the ${step} step is none in factory.config.ts; nothing to do`;
  if ("local" in pin) return `the ${step} step is local (${pin.local}); run it instead`;
  return undefined;
}

/** `factory signoff`: gate@1 on the checked-out branch. */
export async function signoff(args: string[]): Promise<number> {
  if (args.length > 0) {
    console.log("usage: factory signoff");
    return 2;
  }
  const resolved = await loadProject();
  const skip = skipped(resolved, "gate");
  if (skip) {
    console.log(skip);
    return 0;
  }
  const { root, gate } = resolved;
  const machine = machineConfig(repoName(exec).split("/")[1]!);
  const base = `origin/${gate.base}`;
  const stats = new Map<string, CheckStats>();
  let release = () => {};
  const guard = stopOnSignal(() => release());
  try {
    return await signOff({
      sh: exec,
      checks: projectChecks(gate, { root, machine, sh: exec }),
      docs: gate.docs,
      base,
      status: gate.status,
      passed: (check, sha) =>
        passCovering(gitMarkers(exec).read(markerOf(check)), sha, exec) !== undefined,
      lock: async () => (release = await holdLock(HEAVY_LOCK, "factory signoff")),
      run: async (check, sha, units) => {
        const logFile = join(mkdtempSync(join(tmpdir(), "factory-sign-off-")), `${check.name}.log`);
        const checkStats: CheckStats = { logFile };
        stats.set(check.name, checkStats);
        console.log(`sign-off: ${check.name} output: ${logFile}`);
        const stop = sampleUsage();
        const verdict = await check.run({
          dir: root,
          base: exec("git", ["rev-parse", base]).stdout.trim(),
          sha,
          units,
          attempt: 0,
          logFile,
          timeoutMs: timeoutMinutes(machine, check.timeout) * 60_000,
          run: guard.run,
          log: (line) => console.log(`sign-off: ${line}`),
        });
        checkStats.usage = stop();
        return verdict;
      },
      log: (line) => console.log(line),
      record: await signOffRecorder(stats, console.log, root),
    });
  } catch (error) {
    console.log(`sign-off: stopped: ${(error as Error).message}`);
    const signal = guard.stopped();
    return signal ? 128 + constants.signals[signal] : 1;
  } finally {
    guard.dispose();
    release();
  }
}

/** The open pull request's base branch, so a stacked branch doesn't run its parent's checks; else the project's base. */
function baseOf(fallback: string): string {
  const view = exec("gh", ["pr", "view", "--json", "baseRefName,state"]);
  try {
    const { baseRefName, state } = JSON.parse(view.stdout) as {
      baseRefName: string;
      state: string;
    };
    return view.status === 0 && state === "OPEN" ? `origin/${baseRefName}` : `origin/${fallback}`;
  } catch {
    return `origin/${fallback}`;
  }
}

const GATE_USAGE = [
  "usage: factory gate checks [<base> [<head>]]   the checks base...head needs, one per line (base alone: this checkout, uncommitted and untracked files included; no range: every check)",
  "       factory gate base                       the branch this one merges into",
  "       factory gate passed <check> <sha ...>   exits 0 when the check's last pass covers every sha",
  "       factory gate record <check> <sha>       records the check's pass on sha",
].join("\n");

/** The gate's pieces for a project's git hooks. */
export async function gate(args: string[]): Promise<number> {
  const [what, ...rest] = args;
  const { gate } = await loadProject();
  if (what === "checks" && rest.length <= 2) {
    const [base, head] = rest;
    const known = (ref: string) => exec("git", ["cat-file", "-e", `${ref}^{commit}`]).status === 0;
    const files =
      base && [base, head].every((ref) => ref === undefined || known(ref))
        ? changedFiles(base, head, exec)
        : undefined;
    if (base && !files)
      console.error(`gate: every check runs: git can't read ${base}...${head ?? "this checkout"}`);
    for (const name of checksFor(gate, base ? files : undefined)) console.log(name);
    return 0;
  }
  if (what === "base" && rest.length === 0) {
    console.log(baseOf(gate.base));
    return 0;
  }
  const [check, ...shas] = rest;
  if (what === "passed" && check && shas.length > 0) {
    const record = gitMarkers(exec).read(markerOf(check));
    const by = shas.map((sha) => passCovering(record, sha, exec));
    if (by.some((ran) => !ran)) return 1;
    console.log(
      `gate: ${check} already passed on ${by[0]!.slice(0, 8)}, the same code; skipping it`,
    );
    return 0;
  }
  if (what === "record" && check && shas.length === 1) {
    gitMarkers(exec).write(markerOf(check), shas[0]!);
    return 0;
  }
  console.log(GATE_USAGE);
  return 2;
}

/** `factory lock [--checks] -- <command ...>`: the command under this machine's heavy lock, or with `--checks` in one of its CHECK_SLOTS check slots. */
export async function lock(args: string[]): Promise<number> {
  const at = args.indexOf("--");
  const command = args.slice(at + 1);
  const flags = args.slice(0, at);
  if (at < 0 || command.length === 0 || flags.some((flag) => flag !== "--checks")) {
    console.error("usage: factory lock [--checks] -- <command ...>");
    return 2;
  }
  if (!flags.includes("--checks")) return runHeavy(command, HEAVY_LOCK);
  const gaveUp = await holdCheckSlot(command.join(" "));
  if (gaveUp) {
    console.error(gaveUp);
    return 1;
  }
  return runHeavy(command, undefined);
}
