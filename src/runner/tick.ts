import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Resolved } from "../config/load.ts";
import type { PaperTrail } from "../config/schema.ts";
import type { Exec } from "../runtime/exec.ts";
import {
  bumpShiftCount,
  checkoutOf,
  type MachineConfig,
  machineConfig,
  parseSettings,
  projectHome,
  queueOn,
  readState,
  runFolder,
  runnerHome,
  servedProjects,
  timeoutMinutes,
  unattended,
  writeState,
} from "../runtime/machine.ts";
import { followUps, marker } from "../steps/file/v1/memo.ts";
import { localDate, localTime } from "../steps/file/v1/record.ts";
import type { Job, Outcome } from "./child.ts";
import {
  foremanArgs,
  freeArgs,
  nextTurn,
  type Position,
  type Preset,
  rota,
  type Slot,
} from "./rota.ts";

/** What a tick needs from the machine; tests pass fakes. */
export type Runner = {
  /** `~/.factory`. */
  home: string;
  sh: Exec;
  run: (job: Job) => Promise<Outcome>;
  now: () => number;
  /** Prints each check and the step it would take; no lock, log, Claude or writes. */
  dry: boolean;
  print: (line: string) => void;
  pid: number;
  alive: (pid: number) => boolean;
  /** Who files this machine's memos: `person@machine`, lowercased. */
  who: () => string;
  /** Turns the runner off once a stopping machine has drained. */
  turnOff: () => void;
  user?: string;
};

export const TOKEN_FILE = "claude-token";
const DAY = 24 * 3600;
const TRIAGE_AGAIN_HOURS = 6;

const UNATTENDED =
  "You run unattended: the factory runner started you, and nobody reads this session or answers a question. Never wait on a person: post a question on GitHub where the skill says and carry on.";

/** One project this machine serves, as the tick sees it. */
type Project = { name: string; config: MachineConfig; checkout: string | undefined };

/** What one step found to do, and how to do it; `go` returns the runner log line. */
type Work = { step: string; project?: string; why: string; go: () => Promise<string> };

const named = ({ step, project }: Work) => (project ? `${step} on ${project}` : step);

/** `<n>` from each `<n>\t...` line; a `# order:` line isn't one. */
export const numbers = (text: string) =>
  text.split("\n").flatMap((line) => {
    const n = /^#?(\d+)\t/.exec(line)?.[1];
    return n ? [Number(n)] : [];
  });

/** In-flight lines whose ticket waits on a person (its PR's auto-merge is off): nothing for Claude to do. */
export const waiting = (inFlight: string) =>
  inFlight
    .split("\n")
    .filter((line) => line.split("\t")[3]?.startsWith("waits"))
    .flatMap((line) => numbers(line));

/** A memo's signature: its state, its comment count and its follow-up boxes, `x` ticked and `o` not. */
export type Signature = { state: string; comments: number; boxes: string };

export const signatureLine = ({ state, comments, boxes }: Signature) =>
  `${state} ${comments} -${boxes}`;

export function parseSignature(line: string): Signature | undefined {
  const found = /^(\S+) (\d+) -([xo]*)$/.exec(line.trim());
  return found ? { state: found[1]!, comments: Number(found[2]), boxes: found[3]! } : undefined;
}

/** Why a memo has news for the meeting's Memos step since the runner last saw it, or undefined. */
export function memoNews(
  n: number,
  now: Signature,
  seen: Signature | undefined,
): string | undefined {
  // A memo the runner hasn't seen counts from nothing: no comments, no box ticked.
  const was = seen ?? { state: "OPEN", comments: 0, boxes: now.boxes.replace(/x/g, "o") };
  if (now.comments > was.comments)
    return `memo #${n} has ${now.comments - was.comments} new comment(s)`;
  if (now.boxes !== was.boxes) return `boxes changed on memo #${n}`;
  if (now.state === "CLOSED" && was.state === "OPEN" && now.boxes.includes("o"))
    return `memo #${n} closed with unticked boxes`;
  return undefined;
}

/** Whether triage is due: a new untriaged set, or the same one 6 hours on. */
export function triageDue(set: string, state: MachineConfig, now: number) {
  if (set !== state.TRIAGED_SET) return true;
  return now / 1000 > Number(state.TRIAGED_AT ?? 0) + TRIAGE_AGAIN_HOURS * 3600;
}

const when = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** One tick: the first step with work, or nothing. launchd runs one every 15 minutes. */
export async function tick(r: Runner): Promise<number> {
  const { home, sh, dry } = r;
  const R = runnerHome(home);
  const say = (line: string) => dry && r.print(`  ${line}`);
  const log = (line: string) => {
    const stamped = `${localDate(new Date(r.now()))} ${localTime(new Date(r.now()))} ${line}`;
    if (dry) r.print(`would log: ${stamped}`);
    else {
      mkdirSync(R, { recursive: true });
      appendFileSync(join(R, "runner.log"), `${stamped}\n`);
    }
  };
  const machine = parseSettings(
    existsSync(join(home, "machine")) ? readFileSync(join(home, "machine"), "utf8") : "",
  );
  const runnerState = readState(join(R, "state"));
  const lunchUntil = Number(runnerState.LUNCH_UNTIL ?? 0);
  const lunch = r.now() / 1000 < lunchUntil;
  const stopping = existsSync(join(R, "stopping"));
  const tokenFile = join(home, TOKEN_FILE);
  const tokenOk = existsSync(tokenFile) && (statSync(tokenFile).mode & 0o777) === 0o600;
  const slots = rota(machine);
  const projects: Project[] = servedProjects(home).map((name) => {
    const config = machineConfig(name, home);
    return { name, config, checkout: checkoutOf(config, r.user ?? homedir()) };
  });

  if (dry) {
    r.print(
      `factory runner dry run, ${new Date(r.now()).toString().slice(0, 21)}, rota ${typeof slots === "string" ? `unreadable: ${slots}` : (machine.ROTA ?? "default")}`,
    );
    for (const p of projects)
      r.print(
        `project ${p.name}: ${p.checkout ?? "no CHECKOUT"}, queue ${queueOn(p.config) ? "on" : "off"}, unattended ${unattended(p.config) ? "on" : "off"}, mobile ${p.config.MOBILE_SIGNOFF === "on" ? "on" : "off"}`,
      );
    r.print(`token: ${tokenOk ? "present" : `none at ${tokenFile} (mode 600)`}`);
    if (lunch) r.print(`lunch break until ${when(lunchUntil)} (${runnerState.LUNCH_WHY ?? "?"})`);
    if (stopping) r.print("stopping: only the queue and tickets in flight, then off");
    r.print("checks:");
  }
  if (projects.length === 0) {
    log("idle: no PROJECTS in the machine config");
    return 0;
  }
  if (typeof slots === "string") {
    log(`not run: ${slots}`);
    return 1;
  }

  const lock = join(R, "lock");
  const holder = () => {
    if (!existsSync(lock)) return undefined;
    const pid = Number(existsSync(join(lock, "pid")) ? readFileSync(join(lock, "pid"), "utf8") : 0);
    // Taken a moment ago and the pid not written yet, unless it has sat empty for 10 minutes.
    if (!pid) return r.now() - statSync(lock).mtimeMs < 10 * 60_000 ? "?" : undefined;
    return r.alive(pid) ? String(pid) : undefined;
  };
  const step = (what: string) => !dry && writeFileSync(join(lock, "step"), what);
  if (dry) {
    const pid = holder();
    if (pid) say(`lock: held by pid ${pid} (${readFileSync(join(lock, "step"), "utf8").trim()})`);
  } else {
    const pid = holder();
    if (pid) {
      log(
        `busy: ${existsSync(join(lock, "step")) ? readFileSync(join(lock, "step"), "utf8").trim() : "?"}, pid ${pid}`,
      );
      return 0;
    }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(r.pid));
    step("checks");
  }

  try {
    return await work();
  } finally {
    if (!dry) rmSync(lock, { recursive: true, force: true });
  }

  async function work(): Promise<number> {
    const claudeReady = (what: string) => {
      if (!tokenOk) say(`${what}: skipped, no Claude token at ${tokenFile} (mode 600)`);
      else if (lunch) say(`${what}: skipped, lunch break until ${when(lunchUntil)}`);
      return tokenOk && !lunch;
    };
    const failures: string[] = [];

    const factory = (p: Project, args: string[]) => {
      const result = sh("pnpm", ["--silent", "factory", ...args], { cwd: p.checkout! });
      if (result.status === 0) return result.stdout;
      const first = result.stderr.trim().split("\n")[0] || result.stdout.trim().split("\n")[0];
      failures.push(`${p.name}: factory ${args[0]} failed: ${first || `exit ${result.status}`}`);
      say(failures.at(-1)!);
      return undefined;
    };

    const synced = new Map<string, string | true>();
    // Fast-forwards the checkout to origin/main once a tick: true, or why not.
    const sync = (p: Project): string | true => {
      const known = synced.get(p.name);
      if (known) return known;
      const git = (args: string[]) => sh("git", args, { cwd: p.checkout! });
      const why = ((): string | true => {
        if (!p.checkout || !existsSync(p.checkout))
          return `no checkout at ${p.checkout ?? "CHECKOUT"}`;
        if (dry) return true;
        if (git(["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim() !== "main")
          return `${p.checkout} is not on main`;
        if (git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim())
          return `${p.checkout} has uncommitted changes`;
        if (git(["fetch", "-q", "origin"]).status !== 0) return "git fetch failed";
        const before = git(["rev-parse", "HEAD"]).stdout.trim();
        if (git(["merge", "-q", "--ff-only", "origin/main"]).status !== 0)
          return "main doesn't fast-forward to origin/main";
        if (git(["diff", "--quiet", before, "HEAD", "--", "pnpm-lock.yaml"]).status !== 0) {
          const install = sh("pnpm", ["install", "--frozen-lockfile"], { cwd: p.checkout });
          if (install.status !== 0) return "pnpm install failed";
        }
        return true;
      })();
      synced.set(p.name, why);
      if (why !== true) {
        failures.push(`${p.name}: checkout not synced, ${why}`);
        say(failures.at(-1)!);
      }
      return why;
    };

    const cache = new Map<string, string | undefined>();
    const read = (p: Project, args: string[]) => {
      const key = `${p.name} ${args.join(" ")}`;
      if (!cache.has(key)) cache.set(key, sync(p) === true ? factory(p, args) : undefined);
      return cache.get(key);
    };
    const resolved = (p: Project) => {
      const text = read(p, ["resolve"]);
      return text === undefined ? undefined : (JSON.parse(text) as Resolved);
    };
    const trailOf = (p: Project): PaperTrail | undefined => {
      const trail = resolved(p)?.paperTrail;
      return trail && trail !== "none" ? trail : undefined;
    };
    const stamp = () => new Date(r.now()).toTimeString().slice(0, 8).replace(/:/g, "");
    // Every job shares the day's run folder, where in-flight finds quality control's reports; each keeps its logs in its own.
    const runDir = (p: Project) => runFolder(p.name, localDate(new Date(r.now())), home);
    const folder = (p: Project, what: string) => {
      const dir = join(runDir(p), `${stamp()}-${what}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const inFlight = (p: Project) => read(p, ["in-flight", "--run-dir", runDir(p)]);
    /** The tickets in flight here that Claude can move: not those waiting on a person. */
    const movable = (p: Project) => {
      const lines = inFlight(p);
      if (lines === undefined) return undefined;
      const stuck = waiting(lines);
      return numbers(lines).filter((n) => !stuck.includes(n));
    };

    const claude = async (
      p: Project,
      dir: string,
      prompt: string,
      note = "",
      capMinutes = timeoutMinutes(p.config, "TIMEOUT_RUN"),
    ) => {
      const started = r.now();
      writeFileSync(join(dir, "claude.log"), `prompt: ${prompt}\n`);
      const outcome = await r.run({
        prefix: join(dir, "claude"),
        command:
          machine.CLAUDE?.replace(/^(?:~|\$HOME)(?=\/)/, r.user ?? homedir()) ??
          join(r.user ?? homedir(), ".local/bin/claude"),
        args: [
          "-p",
          prompt,
          "--append-system-prompt",
          `${UNATTENDED}${note ? ` ${note}` : ""}`,
          "--permission-mode",
          "auto",
          "--permission-prompts",
          "none",
          "--disallowedTools",
          "AskUserQuestion",
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-turns",
          machine.MAX_TURNS ?? "400",
        ],
        cwd: p.checkout!,
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: readFileSync(tokenFile, "utf8").trim(),
          // claude -p stops background agents 10 min after the foreman's last turn; the cap bounds the wait instead.
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
          FACTORY_RUN_DIR: runDir(p),
        },
        capMinutes,
        claude: true,
      });
      const s = outcome.summary;
      const parts = [
        `exit ${outcome.exit}`,
        duration(r.now() - started),
        `${s?.tokens ?? "?"} tokens`,
        `${s?.agents ?? "?"} agents`,
      ];
      if (s?.limitResetsAt) {
        if (!dry) {
          writeState(join(R, "state"), "LUNCH_UNTIL", s.limitResetsAt);
          writeState(join(R, "state"), "LUNCH_WHY", "usage limit");
        }
        parts.push(`usage limit, lunch break until ${when(s.limitResetsAt)}`);
      }
      if (outcome.timedOut) parts.push(`hit the cap (${capMinutes} min)`);
      if (outcome.stopped) parts.push("stopped by a signal");
      const ok = !s?.limitResetsAt && !outcome.timedOut && !outcome.stopped && outcome.exit === 0;
      return { outcome, ok, said: parts.join(", ") };
    };

    // --- memos -----------------------------------------------------------------

    const memosDir = (p: Project) => join(projectHome(p.name, home), "memos");
    const signature = (trail: PaperTrail, n: number): Signature | undefined => {
      const result = sh("gh", [
        "issue",
        "view",
        String(n),
        "-R",
        trail.repo,
        "--json",
        "state,comments,body",
      ]);
      if (result.status !== 0) return undefined;
      const issue = JSON.parse(result.stdout) as {
        state: string;
        comments: unknown[];
        body: string;
      };
      const boxes = followUps(issue.body)
        .map((box) => (box.ticked ? "x" : "o"))
        .join("");
      return { state: issue.state, comments: issue.comments.length, boxes };
    };
    const saveSignature = (p: Project, trail: PaperTrail, n: number) => {
      const now = signature(trail, n);
      if (!now || dry) return;
      mkdirSync(memosDir(p), { recursive: true });
      writeFileSync(join(memosDir(p), String(n)), signatureLine(now));
    };
    const seenOf = (p: Project, n: number) => {
      const file = join(memosDir(p), String(n));
      return existsSync(file) ? parseSignature(readFileSync(file, "utf8")) : undefined;
    };

    const memos = (p: Project): Work | undefined => {
      if (!claudeReady(`memos on ${p.name}`)) return undefined;
      const trail = trailOf(p);
      if (!trail) return void say(`memos on ${p.name}: no paper trail`);
      const list = (state: string, limit: number) =>
        sh("gh", [
          "issue",
          "list",
          "-R",
          trail.repo,
          "--label",
          trail.memoLabel,
          "--state",
          state,
          "--limit",
          String(limit),
          "--json",
          "number",
          "--jq",
          ".[].number",
        ]);
      const newest = list("all", 1);
      const open = list("open", 200);
      if (newest.status !== 0 || open.status !== 0)
        return void say(`memos on ${p.name}: gh failed`);
      // Every open memo, the newest in any state, and any last seen open, so one closed since still counts.
      const seenOpen = existsSync(memosDir(p))
        ? readdirSync(memosDir(p))
            .filter((n) => seenOf(p, Number(n))?.state === "OPEN")
            .map(Number)
        : [];
      const ids = (text: string) => text.split(/\s+/).filter(Boolean).map(Number);
      const candidates = [
        ...new Set([...ids(newest.stdout), ...ids(open.stdout), ...seenOpen]),
      ].sort((a, b) => a - b);
      const news: { n: number; why: string }[] = [];
      for (const n of candidates) {
        const now = signature(trail, n);
        if (!now) {
          say(`memos on ${p.name}: gh failed on memo #${n}`);
          continue;
        }
        const why = memoNews(n, now, seenOf(p, n));
        if (why) news.push({ n, why });
        else {
          say(`memos on ${p.name}: nothing new on memo #${n}`);
          // Closed with nothing new: saved, or the open snapshot keeps it on every tick's read.
          if (now.state !== seenOf(p, n)?.state && !dry) {
            mkdirSync(memosDir(p), { recursive: true });
            writeFileSync(join(memosDir(p), String(n)), signatureLine(now));
          }
        }
      }
      if (news.length === 0) return undefined;
      return {
        step: "memos",
        project: p.name,
        why: news.map(({ why }) => why).join("; "),
        go: async () => {
          const urls = news.map(({ n }) => `https://github.com/${trail.repo}/issues/${n}`);
          const ran = await claude(
            p,
            folder(p, "memos"),
            `Invoke the aviously-a-factory:meeting skill and do only its step 2, Memos, run alone unattended, on these memos: ${urls.join(", ")}.`,
          );
          if (ran.ok) for (const { n } of news) saveSignature(p, trail, n);
          return `memos on ${p.name} (#${news.map(({ n }) => n).join(" #")}): ${ran.said}`;
        },
      };
    };

    // --- queue -----------------------------------------------------------------

    const queueRead = new Set<string>();
    const queue = (p: Project): Work | undefined => {
      if (!queueOn(p.config)) return void say(`queue on ${p.name}: off here (QUEUE=on runs it)`);
      if (sync(p) !== true) return undefined;
      const prs = sh(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--base",
          "main",
          "--json",
          "number,isDraft,isCrossRepository,autoMergeRequest",
          "--jq",
          '[.[] | select(.autoMergeRequest != null and (.isDraft | not) and (.isCrossRepository | not)) | "#\\(.number)"] | join(" ")',
        ],
        { cwd: p.checkout! },
      );
      if (prs.status !== 0) return void say(`queue on ${p.name}: gh failed`);
      queueRead.add(p.name);
      const queued = prs.stdout.trim();
      if (!queued) return void say(`queue on ${p.name}: no PR has auto-merge on`);
      return {
        step: "queue",
        project: p.name,
        why: `auto-merge on ${queued}`,
        go: async () => {
          const dir = folder(p, "queue");
          const started = r.now();
          const outcome = await r.run({
            prefix: join(dir, "queue"),
            command: "pnpm",
            args: ["--silent", "factory", "queue"],
            cwd: p.checkout!,
            env: { ...process.env, FACTORY_RUN_DIR: runDir(p) },
          });
          return `queue on ${p.name} ${queued}: exit ${outcome.exit}, ${duration(r.now() - started)} (log ${dir})`;
        },
      };
    };

    // --- shift -----------------------------------------------------------------

    const shiftWork = (p: Project, preset: Preset) => {
      const resume = movable(p);
      if (resume === undefined) return undefined;
      const free = read(p, ["free", ...freeArgs(preset)]);
      if (free === undefined) return undefined;
      const order = /^# order: (.*)$/m.exec(free)?.[1];
      const tickets = numbers(free);
      say(
        `shift ${preset.name} on ${p.name}: free ${tickets.length ? `#${tickets.join(" #")}` : "none"}${order ? ` (${order})` : ""}, in flight here ${resume.length ? `#${resume.join(" #")}` : "none"}`,
      );
      if (resume.length === 0 && tickets.length === 0) return undefined;
      return [
        ...(resume.length ? [`in flight here: #${resume.join(" #")}`] : []),
        ...(tickets.length ? [`free: #${tickets.join(" #")}`] : []),
      ].join("; ");
    };

    const runShift = async (
      p: Project,
      why: string,
      prompt: string,
      note: string,
      preset?: Preset,
    ) => {
      const count = dry ? 0 : bumpShiftCount(p.name, home);
      const dir = folder(p, `shift-${count}`);
      const ran = await claude(
        p,
        dir,
        prompt,
        note,
        preset?.minutes ?? timeoutMinutes(p.config, "TIMEOUT_RUN"),
      );
      const memo = fileUnlessFiled(p, count, dir, ran);
      return `shift ${count} on ${p.name}${preset ? ` (${preset.name})` : ""} (${why}): ${ran.said}, ${memo} (log ${dir})`;
    };

    /** The shift's memo section, or one saying it died; its timesheet row too when it died. */
    const fileUnlessFiled = (
      p: Project,
      count: number,
      dir: string,
      ran: Awaited<ReturnType<typeof claude>>,
    ) => {
      const trail = trailOf(p);
      if (!trail) return "no paper trail";
      const today = localDate(new Date(r.now()));
      const who = r.who();
      const open = sh("gh", [
        "issue",
        "list",
        "-R",
        trail.repo,
        "--label",
        trail.memoLabel,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,body",
      ]);
      const memos =
        open.status === 0
          ? (JSON.parse(open.stdout) as { number: number; title: string; body: string }[])
          : [];
      const mine = memos.filter((m) => m.title.toLowerCase().includes(who));
      const filed = mine.find((m) => m.body.includes(marker(count)));
      if (filed && ran.ok) {
        saveSignature(p, trail, filed.number);
        return `memo #${filed.number}`;
      }
      if (filed) saveSignature(p, trail, filed.number);
      const s = ran.outcome.summary;
      const reason = ran.outcome.timedOut
        ? "hit the cap"
        : ran.outcome.stopped
          ? "stopped by a signal (factory runner off or a shutdown)"
          : s?.limitResetsAt
            ? `hit the usage limit; lunch break until ${when(s.limitResetsAt)}`
            : s?.subtype === "error_max_turns"
              ? `ran out of turns (--max-turns ${machine.MAX_TURNS ?? "400"})`
              : ran.outcome.exit !== 0
                ? `claude exited ${ran.outcome.exit}`
                : "finished without filing its memo";
      const filedNote = [];
      if (s?.session) {
        const sheet = factory(p, ["timesheet", s.session]);
        filedNote.push(sheet === undefined ? "timesheet failed" : "timesheet filed");
      }
      if (filed) return `memo #${filed.number}, ${filedNote.join(", ")}`;
      const day = mine
        .find((m) => m.title.startsWith(`Factory ${today} · `))
        ?.title.split(" · ")
        .slice(2)
        .join(" · ");
      const input = {
        mode: "lights-out",
        summary: `died, no memo: ${reason}`,
        day: day || "a shift died",
        intake: "unknown: the shift died before its memo",
        mix: "none built",
        notes: [
          `Claimed tickets and their branches resume on the next shift.`,
          `Exit ${ran.outcome.exit}, result \`${s?.subtype ?? "none"}\`, ${s?.turns ?? "?"} turns, ${s?.tokens ?? "?"} tokens, ${s?.agents ?? "?"} agents, $${s?.costUsd ?? "?"}`,
          `Logs on ${who}: \`${join(dir, "claude.log")}\`, \`${join(dir, "claude.jsonl")}\``,
          ...(s?.result ? [`Last result: ${s.result.slice(0, 3000).replace(/\s+/g, " ")}`] : []),
        ],
      };
      const file = join(dir, "memo-died.json");
      writeFileSync(file, JSON.stringify(input, null, 2));
      const out = factory(p, ["memo", file, "--run-dir", runDir(p)]);
      return [out === undefined ? "died, its memo failed" : "died, memo filed", ...filedNote].join(
        ", ",
      );
    };

    const position = (): Position => ({
      at: Number(runnerState.ROTA_AT ?? 0),
      done: (runnerState.ROTA_DONE ?? "").split(",").filter(Boolean),
    });
    const savePosition = ({ at, done }: Position) => {
      if (dry) return;
      writeState(join(R, "state"), "ROTA_AT", at);
      writeState(join(R, "state"), "ROTA_DONE", done.join(","));
    };
    const shifts = projects.filter((p) => {
      if (!unattended(p.config)) say(`shifts on ${p.name}: off here (UNATTENDED=off)`);
      return unattended(p.config);
    });

    const shift = (): Work | undefined => {
      if (!claudeReady("shift")) return undefined;
      const found = new Map<string, string | undefined>();
      const turn = nextTurn(
        slots as Slot[],
        shifts.map((p) => p.name),
        position(),
        (preset, name) => {
          const key = `${preset.name} ${name}`;
          if (!found.has(key)) {
            const p = shifts.find((each) => each.name === name)!;
            if (preset.mode && preset.mode !== "lights-out") {
              say(
                `shift ${preset.name}: ${preset.mode}; a person starts it with factory runner shift ${name} ${preset.name}`,
              );
              found.set(key, undefined);
            } else found.set(key, shiftWork(p, preset));
          }
          return found.get(key) !== undefined;
        },
      );
      if (turn.take === "nothing") return void say("shift: nothing to build on the rota");
      // A project whose checks failed may have had work: no lunch break on its account.
      if (turn.take === "lunch" && failures.length) return undefined;
      if (turn.take === "lunch")
        return {
          step: "lunch break",
          why: `the rota's lunch break, ${turn.minutes} min`,
          go: async () => {
            const until = Math.round(r.now() / 1000) + turn.minutes * 60;
            writeState(join(R, "state"), "LUNCH_UNTIL", until);
            writeState(join(R, "state"), "LUNCH_WHY", "rota");
            savePosition(turn.next);
            return `lunch break until ${when(until)}, from the rota`;
          },
        };
      const p = shifts.find((each) => each.name === turn.project)!;
      const why = found.get(`${turn.preset.name} ${turn.project}`)!;
      return {
        step: "shift",
        project: p.name,
        why: `${turn.preset.name}, ${why}`,
        go: async () => {
          savePosition(turn.next);
          return runShift(
            p,
            why,
            `/aviously-a-factory:foreman ${foremanArgs(turn.preset, "lights-out")}`,
            "",
            turn.preset,
          );
        },
      };
    };

    // A stopping machine only finishes what is in flight here.
    const finishing = (p: Project): Work | undefined => {
      const all = inFlight(p);
      const resume = movable(p);
      if (all === undefined || resume === undefined) return undefined;
      const stuck = waiting(all);
      say(
        `stopping, in flight on ${p.name}: ${numbers(all).length ? `#${numbers(all).join(" #")}` : "none"}; free tickets wait`,
      );
      if (stuck.length) say(`stopping: #${stuck.join(" #")} wait on a person; no Claude for them`);
      if (resume.length === 0 || !claudeReady(`finish ${p.name}`)) return undefined;
      return {
        step: "shift",
        project: p.name,
        why: `stopping, in flight here: #${resume.join(" #")}`,
        go: () =>
          runShift(
            p,
            `stopping, in flight: #${resume.join(" #")}`,
            `/aviously-a-factory:foreman lights-out ${resume.join(" ")}`,
            "The machine is stopping: finish only these tickets already in flight, claim nothing new, and file follow-ups without adding them to this shift.",
          ),
      };
    };

    // --- triage ----------------------------------------------------------------

    const stateFile = (p: Project) => join(projectHome(p.name, home), "state");
    const triage = (p: Project): Work | undefined => {
      if (!claudeReady(`triage on ${p.name}`)) return undefined;
      const listed = read(p, ["untriaged"]);
      if (listed === undefined) return undefined;
      const tickets = numbers(listed);
      if (tickets.length === 0) return void say(`triage on ${p.name}: nothing untriaged`);
      const set = createHash("sha1")
        .update(tickets.sort((a, b) => a - b).join(" "))
        .digest("hex");
      const state = readState(stateFile(p));
      if (!triageDue(set, state, r.now()))
        return void say(
          `triage on ${p.name}: same untriaged set as at ${when(Number(state.TRIAGED_AT))}`,
        );
      return {
        step: "triage",
        project: p.name,
        why: `untriaged: #${tickets.join(" #")}`,
        go: async () => {
          writeState(stateFile(p), "TRIAGED_SET", set);
          writeState(stateFile(p), "TRIAGED_AT", Math.round(r.now() / 1000));
          const ran = await claude(
            p,
            folder(p, "triage"),
            `Spawn the aviously-a-factory:receptionist agent to route these untriaged tickets: #${tickets.join(" #")}. Don't run the queue, claim or build anything.`,
          );
          return `triage on ${p.name} (#${tickets.join(" #")}): ${ran.said}`;
        },
      };
    };

    // --- performance review ----------------------------------------------------

    const review = (p: Project): Work | undefined => {
      if (!claudeReady(`performance review on ${p.name}`)) return undefined;
      const pin = resolved(p)?.steps["performance-review"];
      if (!pin || pin === "none" || !trailOf(p))
        return void say(`performance review on ${p.name}: the step or the paper trail is none`);
      const due = read(p, ["review-due"]);
      if (due?.trim() !== "due")
        return void say(`performance review on ${p.name}: ${due?.trim() ?? "?"}`);
      const box = read(p, ["suggestion-box", "list"]);
      if (!box || /^# through: -$/m.test(box))
        return void say(`performance review on ${p.name}: the suggestion box is empty`);
      return {
        step: "performance review",
        project: p.name,
        why: "due, with suggestions waiting",
        go: async () => {
          const ran = await claude(
            p,
            folder(p, "performance-review"),
            `Invoke the aviously-a-factory:foreman skill and do only step 10.2 of it, Performance review, run alone unattended: hire HR on a factory/performance-review-${localDate(new Date(r.now()))} worktree, wait for it to hand back, then stop. Claim, build and file nothing else.`,
          );
          return `performance review on ${p.name}: ${ran.said}`;
        },
      };
    };

    // --- nightly ---------------------------------------------------------------

    // Spends no tokens and shares the queue's machine, so it runs only where QUEUE=on.
    const nightly = (p: Project): Work | undefined => {
      const command = p.config.NIGHTLY;
      if (!command) return undefined;
      if (!queueOn(p.config)) return void say(`nightly on ${p.name}: off here (QUEUE=on runs it)`);
      const last = Number(readState(stateFile(p)).NIGHTLY_LAST ?? 0);
      if (r.now() / 1000 - last < DAY) return void say(`nightly on ${p.name}: ran ${when(last)}`);
      if (sync(p) !== true) return undefined;
      return {
        step: "nightly",
        project: p.name,
        why: "nightly due",
        go: async () => {
          const dir = folder(p, "nightly");
          const started = r.now();
          const outcome = await r.run({
            prefix: join(dir, "nightly"),
            command: "/bin/sh",
            args: ["-c", command],
            cwd: p.checkout!,
            env: { ...process.env, FACTORY_RUN_DIR: runDir(p) },
          });
          writeState(stateFile(p), "NIGHTLY_LAST", Math.round(r.now() / 1000));
          return `nightly on ${p.name}: exit ${outcome.exit}, ${duration(r.now() - started)} (log ${dir})`;
        },
      };
    };

    const each =
      (find: (p: Project) => Work | undefined, among = projects) =>
      () => {
        let first: Work | undefined;
        for (const p of among) {
          if (first && !dry) break;
          const found = find(p);
          if (found) {
            say(`${named(found)}: work, ${found.why}`);
            first ??= found;
          }
        }
        return first;
      };
    const steps: (() => Work | undefined)[] = stopping
      ? [each(queue), each(finishing, shifts)]
      : [each(memos), each(queue), shift, each(triage, shifts), each(review), each(nightly)];

    let chosen: Work | undefined;
    for (const find of steps) {
      if (chosen && !dry) break;
      const found = find();
      if (found && find === shift) say(`${named(found)}: work, ${found.why}`);
      chosen ??= found;
    }

    if (!chosen) {
      if (
        stopping &&
        failures.length === 0 &&
        shifts.every((p) => numbers(inFlight(p) ?? "").length === 0) &&
        projects.every((p) => !queueOn(p.config) || queueRead.has(p.name))
      ) {
        log("stopped: queue empty, nothing in flight here; runner off");
        if (!dry) r.turnOff();
        return 0;
      }
      if (failures.length) log(`not run: ${failures.join("; ")}`);
      else if (lunch) log(`lunch break until ${when(lunchUntil)}`);
      else log("idle");
      return 0;
    }
    if (dry) {
      r.print(`would run: ${named(chosen)} (${chosen.why})`);
      return 0;
    }
    step(named(chosen));
    log(await chosen.go());
    return 0;
  }
}
