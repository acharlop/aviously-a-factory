import { realpathSync } from "node:fs";

import { exec, type Exec } from "../runtime/exec.ts";
import { parseWorktrees } from "../runtime/worktrees.ts";

export type Proc = { pid: number; ppid: number; command: string; cwd: string };

/** Every process from `ps -axo pid=,ppid=,command=`, with its cwd from `lsof -d cwd -Fpn` or "?" when lsof can't say. */
export function parseProcesses(ps: string, lsof: string): Proc[] {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) cwds.set(pid, line.slice(1));
  }
  return ps.split("\n").flatMap((line) => {
    const [, pid, ppid, command = ""] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
    return pid
      ? [{ pid: Number(pid), ppid: Number(ppid), command, cwd: cwds.get(Number(pid)) ?? "?" }]
      : [];
  });
}

const inside = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * What runs in the worktree at `root`: processes started in it or naming a path in it, and all
 * their descendants; never one in a worktree nested inside it, and never the pids in `keep`.
 */
export function leftRunning(
  root: string,
  processes: readonly Proc[],
  nested: readonly string[],
  keep: ReadonlySet<number>,
): Proc[] {
  const ours = (path: string) => inside(root, path) && !nested.some((dir) => inside(dir, path));
  const named = (command: string) =>
    [...command.matchAll(/(?:^|\s)(\/\S+)/g)].some(([, path]) => ours(path!));
  const picked = new Set(
    processes.filter(({ cwd, command }) => ours(cwd) || named(command)).map(({ pid }) => pid),
  );
  for (let size = 0; size !== picked.size;) {
    size = picked.size;
    for (const { pid, ppid } of processes) if (picked.has(ppid)) picked.add(pid);
  }
  return processes.filter(({ pid }) => picked.has(pid) && !keep.has(pid));
}

/** This process and its ancestors, which the stop never signals. */
export function ancestors(pid: number, processes: readonly Proc[]): Set<number> {
  const parent = new Map(processes.map((proc) => [proc.pid, proc.ppid]));
  const found = new Set<number>();
  for (let at = pid; at > 0 && !found.has(at); at = parent.get(at) ?? 0) found.add(at);
  return found;
}

const describe = ({ pid, command, cwd }: Proc) => `pid ${pid} (${command}, in ${cwd})`;

/** `factory stop-e2e <worktree>`: stops what a stopped agent left running in its worktree (test runners, browsers, app servers, fakes), a TERM first and a KILL after 5 seconds. */
export async function stopE2e({
  dir,
  sh = exec,
  log = console.log,
  kill = process.kill,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  self = process.pid,
}: {
  dir: string;
  sh?: Exec;
  log?: (line: string) => void;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  self?: number;
}): Promise<void> {
  const root = realpathSync(dir);
  const nested = parseWorktrees(
    sh("git", ["worktree", "list", "--porcelain"], { cwd: root }).stdout,
  )
    .map(({ path }) => path)
    .filter((path) => path !== root && inside(root, path));
  const processes = parseProcesses(
    sh("ps", ["-axo", "pid=,ppid=,command="]).stdout,
    sh("lsof", ["-d", "cwd", "-Fpn"]).stdout,
  );
  const run = leftRunning(root, processes, nested, ancestors(self, processes));
  if (run.length === 0) {
    log(`stop-e2e: nothing is running in ${root}`);
    return;
  }
  const alive = (pid: number) => {
    try {
      kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (pid: number, name: NodeJS.Signals) => {
    try {
      kill(pid, name);
    } catch {}
  };
  for (const proc of run) {
    log(`stop-e2e: stopping ${describe(proc)}`);
    signal(proc.pid, "SIGTERM");
  }
  let left = run.filter(({ pid }) => alive(pid));
  for (let waited = 0; left.length > 0 && waited < 5000; waited += 250) {
    await sleep(250);
    left = left.filter(({ pid }) => alive(pid));
  }
  for (const proc of left) {
    log(`stop-e2e: killing ${describe(proc)}`);
    signal(proc.pid, "SIGKILL");
  }
  log(`stop-e2e: stopped ${run.length} process${run.length === 1 ? "" : "es"} in ${root}`);
}
