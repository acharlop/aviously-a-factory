import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, release, totalmem, uptime } from "node:os";

import { loadProject } from "../../../config/load.ts";
import type { PaperTrail } from "../../../config/schema.ts";
import { filing, type Stamp } from "./record.ts";

type Outcome = "passed" | "failed" | "unaffected" | "gated" | "not-posted" | "refused";

/** One check's verdict on a commit, or why the gate gave none. */
export type SignOff = {
  outcome: Outcome;
  check?: string;
  sha?: string;
  branch?: string;
  base: string;
  command?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  reason?: string;
};

/** What the gate saw while a check ran: its log, the machine's load, and whether the Next build cache was there. */
export type CheckStats = {
  logFile: string;
  /** Hours since the Next build cache last changed when the check started; absent when there was none. */
  nextCacheAgeHours?: number;
  usage?: { peakLoad1m: number; minFreeMemGb: number; startLoad1m: number; startFreeMemGb: number };
};

type GhApi = (args: string[], input?: string) => { status: number | null; stdout: string };

export type Recorder = (signOff: SignOff) => string | undefined;

export const oneDecimal = (n: number) => Math.round(n * 10) / 10;
const gb = (bytes: number) => oneDecimal(bytes / 2 ** 30);

const box = (name: string) => ({
  name,
  hostname: hostname(),
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  memGb: gb(totalmem()),
  os: `${process.platform} ${release()} ${arch()}`,
  node: process.version,
  uptimeHours: oneDecimal(uptime() / 3600),
});

/** Sums turbo's "Cached: N cached, M total" lines, one per turbo run in the check. */
export function turboCache(log: string): { cached: number; total: number } | undefined {
  const runs = [...log.matchAll(/Cached:\s+(\d+) cached, (\d+) total/g)];
  if (runs.length === 0) return undefined;
  return runs.reduce(
    (sum, [, cached, total]) => ({
      cached: sum.cached + Number(cached),
      total: sum.total + Number(total),
    }),
    { cached: 0, total: 0 },
  );
}

/** Samples load and free memory every 5s until stopped. */
export function sampleUsage(): () => CheckStats["usage"] {
  const load = () => oneDecimal(loadavg()[0]!);
  const usage = {
    startLoad1m: load(),
    startFreeMemGb: gb(freemem()),
    peakLoad1m: load(),
    minFreeMemGb: gb(freemem()),
  };
  const timer = setInterval(() => {
    usage.peakLoad1m = Math.max(usage.peakLoad1m, load());
    usage.minFreeMemGb = Math.min(usage.minFreeMemGb, gb(freemem()));
  }, 5_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    return usage;
  };
}

/** What a check run adds to its sign-off: the machine's load, the caches, and a failed run's last 200 log lines. */
function checkDetails(signOff: SignOff, stats: CheckStats | undefined) {
  if (!stats) return {};
  const lines = existsSync(stats.logFile) ? readFileSync(stats.logFile, "utf8") : undefined;
  const cache = {
    turbo: lines ? turboCache(lines) : undefined,
    nextAgeHours: stats.nextCacheAgeHours,
  };
  const logTail =
    signOff.outcome === "failed" && lines ? lines.split("\n").slice(-200).join("\n") : undefined;
  return { usage: stats.usage, cache, logTail };
}

/** Commits each sign-off as one JSON file in the paper trail; a failure logs one line and returns undefined. */
export const recorder = (
  trail: PaperTrail,
  stamp: Stamp,
  checkStats: ReadonlyMap<string, CheckStats>,
  log: (line: string) => void,
  gh: GhApi = ghApi,
): Recorder => {
  let down = false;
  const { person, machine: name, ...filed } = stamp;
  const machineNow = box(name);
  return (signOff) => {
    if (down) return undefined;
    try {
      const stats = signOff.check && signOff.startedAt ? checkStats.get(signOff.check) : undefined;
      const body = {
        ...signOff,
        person,
        machine: machineNow,
        ...filed,
        ...checkDetails(signOff, stats),
      };
      const at = new Date().toISOString();
      const name = `${at.replace(/[:.]/g, "-")}-${(signOff.sha ?? "nosha").slice(0, 8)}-${signOff.check ?? signOff.outcome}-${person}.json`;
      const path = `repos/${trail.repo}/contents/${trail.signOffs}/${at.slice(0, 10)}/${name}`;
      const content = Buffer.from(`${JSON.stringify(body, null, 2)}\n`).toString("base64");
      const message = `${signOff.check ?? "sign-off"} ${signOff.outcome} on ${signOff.sha?.slice(0, 8) ?? "no commit"}`;
      const put = gh(
        ["api", "-X", "PUT", path, "--input", "-", "--jq", ".content.html_url"],
        JSON.stringify({ message, content }),
      );
      if (put.status !== 0) throw new Error(`gh api exited ${put.status}`);
      return put.stdout.trim() || undefined;
    } catch (error) {
      // One failure stops the rest, so an unreachable GitHub costs one timeout, not one per check.
      down = true;
      log(
        `sign-off: couldn't file the sign-off in ${trail.repo}, skipping the rest (${(error as Error).message})`,
      );
      return undefined;
    }
  };
};

function ghApi(args: string[], input?: string) {
  const result = spawnSync("gh", args, { input, encoding: "utf8", timeout: 5_000 });
  return { status: result.error ? 1 : result.status, stdout: result.stdout ?? "" };
}

/** The project's sign-off recorder; one that files nothing, and says why once, when the project keeps no paper trail or GitHub can't be reached. */
export async function signOffRecorder(
  checkStats: ReadonlyMap<string, CheckStats>,
  log: (line: string) => void,
  from = process.cwd(),
): Promise<Recorder> {
  let where: ReturnType<typeof filing>;
  try {
    where = filing(await loadProject(from));
  } catch (error) {
    where = `no paper trail (${(error as Error).message})`;
  }
  if (typeof where === "string") {
    log(`sign-off: ${where}`);
    return () => undefined;
  }
  return recorder(where.trail, where.stamp, checkStats, log);
}
