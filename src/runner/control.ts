import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Exec } from "../runtime/exec.ts";
import { takeRunLock } from "../runtime/run-lock.ts";
import { machine } from "../runtime/github.ts";
import {
  checkoutOf,
  machineConfig,
  parseSettings,
  runnerHome,
  servedProjects,
} from "../runtime/machine.ts";
import { foremanArgs, preset, presetKey } from "./rota.ts";
import { LABEL, TMUX } from "./status.ts";
import { TOKEN_FILE } from "./tick.ts";

/** What the runner's controls need from the machine; tests pass fakes. */
export type Control = {
  /** `~/.factory`. */
  home: string;
  user: string;
  sh: Exec;
  uid: number;
  print: (line: string) => void;
};

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where launchd reads the runner's job from. */
export const plistPath = (user: string) => join(user, "Library/LaunchAgents", `${LABEL}.plist`);

/** The launchd job: `factory runner tick` with this node and this CLI, now and every 15 minutes. */
export function plist({
  node,
  cli,
  home,
  user,
}: {
  node: string;
  cli: string;
  home: string;
  user: string;
}): string {
  const path = [
    dirname(node),
    join(user, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const log = join(runnerHome(home), "launchd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>runner</string><string>tick</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>LANG</key><string>en_US.UTF-8</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const loaded = ({ sh, uid }: Control) =>
  sh("launchctl", ["print", `gui/${uid}/${LABEL}`]).status === 0;

/** `factory runner on`: loads the launchd job saved from `factory runner plist`; the first tick runs now. */
export function on(c: Control): number {
  const token = join(c.home, TOKEN_FILE);
  if (!existsSync(token) || (statSync(token).mode & 0o777) !== 0o600) {
    c.print(
      `No Claude token at ${token} (mode 600). Run \`claude setup-token\`, then save it there:`,
    );
    c.print(`  pbpaste > ${token} && chmod 600 ${token}`);
    return 1;
  }
  const path = plistPath(c.user);
  if (!existsSync(path)) {
    c.print(`No launchd job at ${path}. Save it first: factory runner plist > ${path}`);
    return 1;
  }
  if (servedProjects(c.home).length === 0) {
    c.print(`No PROJECTS in ${join(c.home, "machine")}; the runner would have nothing to serve.`);
    return 1;
  }
  rmSync(join(runnerHome(c.home), "stopping"), { force: true });
  c.sh("launchctl", ["bootout", `gui/${c.uid}/${LABEL}`]);
  const booted = c.sh("launchctl", ["bootstrap", `gui/${c.uid}`, path]);
  if (booted.status !== 0) {
    c.print(`launchctl bootstrap failed: ${booted.stderr.trim()}`);
    return 1;
  }
  c.print(
    `Runner on: first tick now, then every 15 min. Log: ${join(runnerHome(c.home), "runner.log")}`,
  );
  return 0;
}

const lockHolder = (home: string) => {
  const lock = join(runnerHome(home), "lock");
  const pid = existsSync(join(lock, "pid")) ? Number(readFileSync(join(lock, "pid"), "utf8")) : 0;
  const step = existsSync(join(lock, "step"))
    ? readFileSync(join(lock, "step"), "utf8").trim()
    : "";
  return { pid, step };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** `factory runner off`: unloads the launchd job; a shift in progress stops and leaves a memo saying so. */
export function off(c: Control): number {
  const { pid, step } = lockHolder(c.home);
  if (pid && alive(pid))
    c.print(
      step === HAND
        ? `A hand-started shift holds the lock (pid ${pid}) and keeps running; stop it from its session (/exit), or kill ${pid}.`
        : `Stopping the ${step || "tick"} in progress (pid ${pid}); the next shift resumes from GitHub.`,
    );
  rmSync(join(runnerHome(c.home), "stopping"), { force: true });
  c.print("Runner off.");
  // Last: when a stopping tick runs this, the bootout ends it.
  c.sh("launchctl", ["bootout", `gui/${c.uid}/${LABEL}`]);
  return 0;
}

/** `factory runner stop`: the runner drains, merging the queue and finishing tickets in flight, then turns itself off. */
export function stop(c: Control): number {
  const flag = join(runnerHome(c.home), "stopping");
  if (!loaded(c)) {
    rmSync(flag, { force: true });
    c.print("Runner already off.");
    return 0;
  }
  mkdirSync(runnerHome(c.home), { recursive: true });
  writeFileSync(flag, "");
  c.print(
    "Runner stopping: no new tickets, triage, memos, performance review or nightly. Ticks merge the queue and finish tickets in flight, then turn it off.",
  );
  c.print(
    "Watch: factory runner status --watch. Stop now instead: factory runner off. Keep going: factory runner on.",
  );
  return 0;
}

/** The lock's step while a person's shift runs in tmux. */
export const HAND = "hand shift";
const SESSION = "factory";

const SHIFT_USAGE =
  "usage: factory runner shift <project> [<preset> | supervised|unsupervised [department:<d>]... [kind:<k>]... [order:<o>] [<ticket>...]]";

/** `factory runner shift`: a shift a person starts and watches, in tmux with Remote Control; again from `ssh -t` rejoins it. */
export function handShift(
  c: Control & {
    tty: boolean;
    /** Runs tmux with the terminal attached; returns its exit status. */
    attach: (args: string[], env: NodeJS.ProcessEnv) => number;
  },
  args: string[],
): number {
  if (c.sh("tmux", [...TMUX, "has-session", "-t", SESSION]).status === 0) {
    if (!c.tty) {
      c.print(
        `A hand-started shift is running in tmux session '${SESSION}'; join it from a terminal: ssh -t <host>, then factory runner shift.`,
      );
      return 0;
    }
    return c.attach([...TMUX, "attach", "-t", SESSION], process.env);
  }
  const [project, ...rest] = args;
  if (!project || !servedProjects(c.home).includes(project)) {
    c.print(SHIFT_USAGE);
    if (project) c.print(`${project} isn't in PROJECTS in ${join(c.home, "machine")}`);
    return 2;
  }
  const config = machineConfig(project, c.home);
  const checkout = checkoutOf(config, c.user);
  const machineWide = parseSettings(
    existsSync(join(c.home, "machine")) ? readFileSync(join(c.home, "machine"), "utf8") : "",
  );
  const named =
    rest.length === 1 && (rest[0] === "default" || machineWide[presetKey(rest[0]!)] !== undefined);
  const found = named ? preset(machineWide, rest[0]!) : undefined;
  if (typeof found === "string") {
    c.print(found);
    return 2;
  }
  const words = found ? foremanArgs(found, found.mode ?? "supervised") : rest.join(" ");
  if (/(^|\s)lights-out(\s|$)/.test(words)) {
    c.print("Lights-out shifts are the runner's: put the preset on the ROTA instead.");
    return 2;
  }
  const claude =
    (machineWide.CLAUDE ?? "").replace(/^(?:~|\$HOME)(?=\/)/, c.user) ||
    join(c.user, ".local/bin/claude");
  if (!existsSync(claude)) {
    c.print(`no claude at ${claude}`);
    return 1;
  }
  if (!checkout || !existsSync(join(checkout, ".git"))) {
    c.print(`no checkout at ${checkout ?? `CHECKOUT in ${join(c.home, project, "config")}`}`);
    return 1;
  }
  // A checkout claude hasn't trusted opens on the trust and project MCP prompts, which swallow the shift's prompt.
  const trusted = (() => {
    try {
      const settings = JSON.parse(readFileSync(join(c.user, ".claude.json"), "utf8")) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      return settings.projects?.[checkout]?.hasTrustDialogAccepted === true;
    } catch {
      return false;
    }
  })();
  if (!trusted) {
    c.print(
      `claude hasn't trusted ${checkout} yet: run claude there once, answer the trust and MCP prompts, exit, then start again.`,
    );
    return 1;
  }
  const lock = join(runnerHome(c.home), "lock");
  const holder = lockHolder(c.home);
  if (holder.pid && alive(holder.pid)) {
    c.print(
      holder.step === HAND
        ? `Another hand-started shift holds ${lock} (pid ${holder.pid}); factory runner status shows how to join or stop it.`
        : `The runner holds ${lock} (${holder.step}, pid ${holder.pid}); wait for it or factory runner off first.`,
    );
    return 1;
  }
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(runnerHome(c.home), { recursive: true });
  // The launcher's pid until the shell below replaces it with claude's, so a failed start leaves a lock the next one clears.
  takeRunLock(HAND, lock);
  const remote =
    config.REMOTE_CONTROL === "off"
      ? ""
      : ` --remote-control 'shift-${machine()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")}'`;
  // tmux refuses to attach from inside another tmux session.
  const { TMUX: _inside, ...outside } = process.env;
  const prompt = `/aviously-a-factory:foreman${words ? ` ${words}` : ""}`;
  const command = `cd '${checkout}' && echo $$ >'${join(lock, "pid")}' && exec '${claude}' --permission-mode auto${remote} '${prompt.replace(/'/g, "'\\''")}'`;
  c.print(
    `Starting a shift on ${project} in tmux session '${SESSION}' (detach: ctrl-b d; rejoin: factory runner shift): ${prompt}`,
  );
  return c.attach(
    [...TMUX, "new-session", ...(c.tty ? [] : ["-d"]), "-s", SESSION, "bash", "-lc", command],
    {
      ...outside,
      // Every agent inherits it: 100k compacted at about 67k with about 57k reloaded each time; 1M let the foreman reach 279k.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: config.COMPACT_WINDOW ?? "200000",
    },
  );
}
