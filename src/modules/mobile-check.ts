import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Check, shell } from "../runtime/checks.ts";
import type { Exec } from "../runtime/exec.ts";
import { runLogged, type Runner } from "../runtime/run.ts";
import { nativeBetween, nativeChanges, notDeviceMachine } from "./mobile.ts";
import type { Module, ModuleContext } from "./module.ts";

/** The flows a `runFlows` log says passed, and those it says failed with where each went wrong. */
export function flowResults(log: string) {
  const passed: string[] = [];
  const failed: { flow: string; at?: string }[] = [];
  for (const line of log.split("\n")) {
    const said = /^(passed|failed) ([^\s:]+)(?::\s*(.+))?$/.exec(line.trim());
    if (said?.[1] === "passed") passed.push(said[2]!);
    else if (said) failed.push({ flow: said[2]!, ...(said[3] && { at: said[3] }) });
  }
  return { passed, failed };
}

/** A status description, which GitHub caps at 140 characters. */
export const describeFlows = (flows: readonly string[]) => {
  const text = flows.length === 0 ? "no flow reached" : `flows passed: ${flows.join(", ")}`;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
};

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const lastLine = (file: string) => read(file).trim().split("\n").at(-1)?.trim() || undefined;

/** Why native changes need a new dev build, or undefined when they need none. */
const reason = (changes: readonly string[] | undefined, range: string) =>
  changes === undefined
    ? `git can't diff ${range}`
    : changes.length > 0
      ? changes.join(", ")
      : undefined;

/** The mobile check: the flows a change reaches, on this machine's simulator, rebuilding its dev build first when a native change needs it. */
export function mobileCheck(
  name: string,
  { modules, machine, home, sh }: ModuleContext,
  // A signal cancels the run it gets, and the device must still be stopped after one.
  cleanup: Runner = (command, logFile, cwd, timeoutMs) =>
    runLogged(command, logFile, cwd, undefined, timeoutMs),
): Check {
  const mobile = modules.mobile;
  if (mobile === "none") throw new Error(`${name} needs the mobile module on in factory.config.ts`);
  const record = join(home, "dev-build");
  const recordBuild = (built: { sha?: string }) => {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${JSON.stringify(built)}\n`);
  };
  /** Why the dev build last built here can't run sha; undefined when it can, or when none was recorded, since a person's own build is trusted. */
  const staleBuild = (sha: string, at: Exec) => {
    if (!existsSync(record)) return undefined;
    const { sha: built } = JSON.parse(read(record) || "{}") as { sha?: string };
    if (!built) return "the last dev build here didn't finish";
    return reason(nativeBetween(mobile, built, sha, at), `${built}..${sha}`);
  };
  return {
    name,
    command: mobile.runFlows,
    timeout: "TIMEOUT_E2E",
    // The first run, a rerun of what failed or didn't finish, and one more for a flow that first failed on that rerun.
    tries: 3,
    marker: false,
    needs: async ({ dir, base }) => {
      const [program = "", ...args] = shell(mobile.listFlows, [base]);
      const listed = sh(program, args, { cwd: dir });
      if (listed.status !== 0)
        return { refused: `listing the flows ${name} runs failed: ${listed.stderr.trim()}` };
      const flows = listed.stdout.split("\n").filter(Boolean);
      return flows.length > 0 ? { units: flows } : undefined;
    },
    unavailable: () => notDeviceMachine(mobile, machine),
    run: async (at) => {
      const git: Exec = (command, args, options) => sh(command, args, { cwd: at.dir, ...options });
      const logOf = (step: string) => at.logFile.replace(/(\.log)?$/, `-${step}.log`);
      const step = (command: string, args: readonly string[], file: string, runner = at.run) =>
        runner(shell(command, args), file, at.dir, at.timeoutMs);
      // A device check a killed run left in this checkout would serve the flows stale code.
      await step(mobile.stopDevice, [], logOf("stop"));
      try {
        const rebuild =
          (at.attempt === 0
            ? reason(nativeChanges(mobile, at.base, at.sha, git), `${at.base}...${at.sha}`)
            : undefined) ?? staleBuild(at.sha, git);
        const started = logOf("device");
        let start;
        if (rebuild) {
          at.log(`${name}: building a new dev build first: ${rebuild}`);
          // Until a build passes the next run rebuilds, since one that failed partway may have installed something.
          recordBuild({});
          // A native build can outlast the flows' timeout, so it runs without one.
          start = await at.run(shell(mobile.buildDevice, []), started, at.dir);
          if (start.passed) recordBuild({ sha: at.sha });
        } else start = await step(mobile.startDevice, [], started);
        if (!start.passed)
          return { unavailable: lastLine(started) ?? "the device check didn't start" };
        const ran = await step(mobile.runFlows, at.units, at.logFile);
        if (ran.passed) return { failed: [] };
        const { passed, failed } = flowResults(read(at.logFile));
        if (passed.length + failed.length === 0)
          return {
            unavailable: ran.timedOut
              ? `the flows ran past ${at.timeoutMs / 60_000} min before naming any`
              : (lastLine(at.logFile) ?? "the flows named none that passed or failed"),
          };
        for (const { flow, at: where } of failed)
          at.log(`${name}: ${flow} failed${where ? ` at ${where}` : ""}`);
        const done = new Set([...passed, ...failed.map(({ flow }) => flow)]);
        const notRun = at.units.filter((flow) => !done.has(flow));
        if (failed.length + notRun.length > 0)
          return { failed: failed.map(({ flow }) => flow), notRun };
        return { unavailable: `the flows failed with none of them failing; see ${at.logFile}` };
      } finally {
        await step(mobile.stopDevice, [], logOf("stop"), cleanup);
      }
    },
    describe: describeFlows,
  };
}

export const mobileModule: Module = {
  name: "mobile",
  summary: "Device checks on one simulator, and native changes left for a person",
  check: mobileCheck,
};
