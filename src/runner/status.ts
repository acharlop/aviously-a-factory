// `factory runner status`: one screen of what the factory on this machine is doing, and a command for each thing that looks stuck.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { Exec } from "../runtime/exec.ts";
import { describeOwner, HEAVY_LOCK, lockOwner } from "../runtime/lock.ts";
import {
  checkoutOf,
  machineConfig,
  queueOn,
  readState,
  runnerHome,
  servedProjects,
  shiftCount,
} from "../runtime/machine.ts";
import { followUps } from "../steps/file/v1/memo.ts";

const ACTIVE_MS = 5 * 60_000;
/** The tmux server a hand-started shift runs on, apart from the person's own. */
export const TMUX = ["-L", "factory", "-f", "/dev/null"];

export const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export function since(start: string | number | undefined, now: number) {
  const ms = typeof start === "string" ? Date.parse(start) : (start ?? Number.NaN);
  if (!Number.isFinite(ms)) return "?";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${minutes(now - ms)}`;
}

/** Claude Code's transcript folder for a working directory. */
export const transcriptsOf = (cwd: string, user = homedir()) =>
  join(user, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

export type Session = {
  pid: number;
  sessionId: string;
  cwd: string;
  kind?: string;
  jobId?: string;
  tmux?: string;
  status?: string;
  entrypoint?: string;
  startedAt?: string | number;
};

/** How to get into a live session: a hand-started shift's tmux, a background session, its tmux pane, else resume it once it's stopped. */
export function jumpIn(session: Session, handShiftPids = new Set<number>()) {
  if (handShiftPids.has(session.pid)) return "factory runner shift";
  if (session.kind === "bg") return `claude attach ${session.jobId ?? session.sessionId}`;
  if (session.tmux) return `tmux attach -t ${session.tmux.split(":")[0]}`;
  return `cd ${session.cwd} && claude --resume ${session.sessionId}   (after it stops)`;
}

/** Follow-up boxes on a memo not yet filed or answered. */
export const unsettled = (body: string) => followUps(body).filter((box) => !box.settled).length;

export type Lock = { pid: number; alive: boolean; step: string };

/** Lines for things that look stuck, each with the command that deals with it. */
export function stuck({
  runnerLock,
  lunchUntil,
  launchd,
  lastTickMs,
  now,
  home,
}: {
  runnerLock: Lock | undefined;
  lunchUntil: number | undefined;
  launchd: boolean;
  lastTickMs: number | undefined;
  now: number;
  home: string;
}): string[] {
  const out: string[] = [];
  if (runnerLock && !runnerLock.alive)
    out.push(
      `runner lock held by dead pid ${runnerLock.pid} → rm -rf ${join(runnerHome(home), "lock")}`,
    );
  if (lunchUntil && lunchUntil > now)
    out.push(
      `lunch break until ${new Date(lunchUntil).toLocaleTimeString()} → nothing to do, the runner waits`,
    );
  // launchd starts no tick while one runs, so a long shift leaves the log quiet without anything being wrong.
  if (launchd && !runnerLock?.alive && lastTickMs !== undefined && now - lastTickMs > 30 * 60_000)
    out.push(
      `runner on but no tick for ${minutes(now - lastTickMs)} → launchctl kickstart -k gui/$(id -u)/${LABEL}`,
    );
  return out;
}

/** The launchd job's label. */
export const LABEL = "aviously-a-factory.runner";

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
const parse = <T>(text: string | undefined): T | undefined => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as T);
  } catch {
    return undefined;
  }
};

export type Probe = {
  home: string;
  /** The machine's heavy lock (Move 5's `factory lock`). */
  heavyLock?: string;
  user: string;
  sh: Exec;
  now: number;
  alive: (pid: number) => boolean;
};

/** Every line of the status screen. */
export function status({ home, heavyLock = HEAVY_LOCK, user, sh, now, alive }: Probe): string[] {
  const run = (command: string, args: string[], cwd?: string) => {
    const r = sh(command, args, cwd === undefined ? {} : { cwd });
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  const R = runnerHome(home);
  const launchd =
    run("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LABEL}`]) !== undefined;
  const logFile = join(R, "runner.log");
  const log = (read(logFile) ?? "").trim().split("\n").filter(Boolean);
  const lastTickMs = existsSync(logFile) ? statSync(logFile).mtimeMs : undefined;
  const state = readState(join(R, "state"));
  const lunchUntil = Number(state.LUNCH_UNTIL) ? Number(state.LUNCH_UNTIL) * 1000 : undefined;
  const projects = servedProjects(home).map((name) => ({
    name,
    config: machineConfig(name, home),
    checkout: checkoutOf(machineConfig(name, home), user),
  }));
  const lines: string[] = [];
  const say = (s = "") => lines.push(s);

  const mode = !launchd
    ? "off"
    : existsSync(join(R, "stopping"))
      ? "STOPPING (queue and in flight only)"
      : "ON";
  say(
    `FACTORY  ${run("scutil", ["--get", "ComputerName"]) ?? "this machine"} · runner ${mode} · rota ${readState(join(home, "machine")).ROTA ?? "default"}${log.length ? ` · last tick: ${log.at(-1)}` : " · no tick logged yet"}`,
  );
  for (const p of projects)
    say(
      `PROJECT  ${p.name} · ${p.checkout ?? "no CHECKOUT"} · shift ${shiftCount(p.name, home)} · queue ${queueOn(p.config) ? "on" : "off"}`,
    );
  const pid = Number(read(join(R, "lock", "pid")));
  const runnerLock = pid
    ? { pid, alive: alive(pid), step: read(join(R, "lock", "step"))?.trim() || "tick" }
    : undefined;
  if (runnerLock)
    say(
      `RUNNER   ${runnerLock.step} in progress, pid ${pid}${runnerLock.alive ? "" : " (dead)"} · stop: kill ${pid}`,
    );

  const heavy = lockOwner(heavyLock);
  say(
    heavy
      ? `HEAVY    ${describeOwner(heavy)}${alive(heavy.pid) ? "" : " (dead; the next taker clears it)"} · stop: kill ${heavy.pid}`
      : "HEAVY    free",
  );

  say();
  say("CLAUDE SESSIONS");
  const dir = join(user, ".claude/sessions");
  const ours = (cwd = "") =>
    projects.some(
      (p) => p.checkout && (cwd.startsWith(p.checkout) || cwd.startsWith(`${p.checkout}-wt`)),
    );
  const live = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .flatMap((f) => parse<Session>(read(join(dir, f))) ?? [])
        .filter((s) => s.pid && alive(s.pid) && ours(s.cwd))
    : [];
  const hand = new Set(
    (run("tmux", [...TMUX, "list-panes", "-a", "-F", "#{pane_pid}"]) ?? "")
      .split("\n")
      .filter(Boolean)
      .map(Number),
  );
  if (!live.length) say("  none");
  for (const s of live) {
    say(
      `  pid ${s.pid}  ${s.sessionId}  ${s.status ?? "?"}  ${s.kind ?? ""}${s.entrypoint ? `/${s.entrypoint}` : ""}  since ${since(s.startedAt, now)}`,
    );
    say(`    cwd  ${s.cwd}`);
    say(`    jump ${jumpIn(s, hand)}`);
    say(`    kill kill ${s.pid}`);
    const agents = join(transcriptsOf(s.cwd, user), s.sessionId, "subagents");
    if (!existsSync(agents)) continue;
    for (const f of readdirSync(agents).filter((f) => f.endsWith(".jsonl"))) {
      const at = statSync(join(agents, f));
      if (now - at.mtimeMs >= ACTIVE_MS) continue;
      const meta = parse<{ description?: string }>(
        read(join(agents, f.replace(/\.jsonl$/, ".meta.json"))),
      );
      say(`    agent ${meta?.description ?? basename(f)} · ${minutes(now - at.birthtimeMs)}`);
    }
  }

  for (const p of projects) {
    if (!p.checkout) continue;
    say();
    say(`IN FLIGHT ON ${p.name}`);
    const flight = (run("pnpm", ["--silent", "factory", "in-flight"], p.checkout) ?? "")
      .split("\n")
      .filter(Boolean);
    if (!flight.length) say("  none");
    for (const line of flight) {
      const [n, title, branch, next] = line.split("\t");
      say(`  #${n}  ${title}\n    branch ${branch} · next: ${next}`);
    }
    say();
    say(`QUEUE ON ${p.name} (auto-merge on)`);
    const prs =
      parse<{ number: number; title: string; autoMergeRequest: object | null }[]>(
        run("gh", ["pr", "list", "--json", "number,title,autoMergeRequest"], p.checkout),
      ) ?? [];
    const queued = prs.filter((pr) => pr.autoMergeRequest);
    if (!queued.length) say("  none");
    for (const pr of queued) say(`  #${pr.number}  ${pr.title}`);

    say();
    say(`NEEDS YOU ON ${p.name}`);
    const before = lines.length;
    const decisions =
      parse<{ number: number; title: string }[]>(
        run(
          "gh",
          ["issue", "list", "--label", "decision needed", "--json", "number,title"],
          p.checkout,
        ),
      ) ?? [];
    for (const i of decisions) say(`  #${i.number} decision needed: ${i.title}`);
    const trail = parse<{ paperTrail: { repo: string; memoLabel: string } | "none" }>(
      run("pnpm", ["--silent", "factory", "resolve"], p.checkout),
    )?.paperTrail;
    if (trail && trail !== "none") {
      const memos =
        parse<{ number: number; body: string }[]>(
          run("gh", [
            "issue",
            "list",
            "-R",
            trail.repo,
            "--label",
            trail.memoLabel,
            "--json",
            "number,body",
          ]),
        ) ?? [];
      for (const m of memos) {
        const open = unsettled(m.body);
        if (open) say(`  memo #${m.number}: ${open} follow-up${open === 1 ? "" : "s"} to settle`);
      }
    }
    if (lines.length === before) say("  nothing");
  }

  const problems = stuck({ runnerLock, lunchUntil, launchd, lastTickMs, now, home });
  say();
  say("STUCK?");
  if (!problems.length) say("  nothing looks stuck");
  for (const line of problems) say(`  ! ${line}`);

  if (log.length) {
    say();
    say("LAST TICKS");
    for (const l of log.slice(-5)) say(`  ${l}`);
  }
  return lines;
}
