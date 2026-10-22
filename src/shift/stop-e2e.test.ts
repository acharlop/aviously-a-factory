import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { ancestors, leftRunning, parseProcesses, type Proc, stopE2e } from "./stop-e2e.ts";

const proc = (pid: number, ppid: number, command: string, cwd: string): Proc => ({
  pid,
  ppid,
  command,
  cwd,
});

test("ps and lsof field output read as processes with their cwd, and ? when lsof has none", () => {
  const ps = "    1     0 /sbin/launchd\n  501     1 node scripts/fake-mail.ts\n";
  const lsof = ["p1", "fcwd", "n/", "p501", "fcwd", "n/wt/e2e"].join("\n");
  assert.deepEqual(parseProcesses(ps, lsof), [
    proc(1, 0, "/sbin/launchd", "/"),
    proc(501, 1, "node scripts/fake-mail.ts", "/wt/e2e"),
  ]);
  assert.deepEqual(parseProcesses("  7  1 sh\n", ""), [proc(7, 1, "sh", "?")]);
});

test("what's left running is what started in or names the worktree, with its children, and nothing of a worktree nested in it or another one", () => {
  const main = "/code/app";
  const wt = "/code/app/.claude/worktrees/897-a";
  const other = "/code/app/.claude/worktrees/897-a-2";
  const processes = [
    proc(10, 1, "node playwright test", join(wt, "e2e")),
    proc(11, 10, "Chrome for Testing --headless", "/"),
    proc(13, 1, `node ${wt}/node_modules/.bin/vitest`, "/"),
    proc(14, 1, "next-server", join(wt, "web")),
    proc(20, 1, "node playwright test", join(main, "e2e")),
    proc(21, 1, "node scripts/fake-mail.ts", join(other, "e2e")),
    proc(22, 1, `node ${other}/node_modules/.bin/vitest`, other),
  ];
  const pids = (run: Proc[]) => run.map(({ pid }) => pid);
  assert.deepEqual(pids(leftRunning(wt, processes, [], new Set())), [10, 11, 13, 14]);
  assert.deepEqual(pids(leftRunning(wt, processes, [], new Set([10, 1]))), [11, 13, 14]);
  assert.deepEqual(pids(leftRunning(main, processes, [wt, other], new Set())), [20]);
});

test("this process and its ancestors are kept, up to launchd", () => {
  const processes = parseProcesses("1 0 launchd\n50 1 zsh\n60 50 node\n70 1 other\n", "");
  assert.deepEqual([...ancestors(60, processes)], [60, 50, 1]);
});

test("a stop terms what's left running, kills what outlives the wait, and leaves the rest alone", async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "stop-e2e-")));
  mkdirSync(join(wt, "web"));
  const table: Record<number, Proc> = {
    100: proc(100, 1, "node playwright test", wt),
    101: proc(101, 1, "next-server", join(wt, "web")),
    103: proc(103, 1, "node playwright test", "/elsewhere"),
  };
  const alive = new Set([100, 101, 103]);
  const sh: Exec = (command, args) => {
    const out = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (command === "git") return out(`worktree ${wt}\nHEAD a\nbranch refs/heads/web/1-a\n`);
    if (command === "ps")
      return out(
        [...alive].map((pid) => `${pid} ${table[pid]!.ppid} ${table[pid]!.command}`).join("\n"),
      );
    assert.deepEqual(args, ["-d", "cwd", "-Fpn"]);
    return out([...alive].map((pid) => `p${pid}\nfcwd\nn${table[pid]!.cwd}`).join("\n"));
  };
  const signals: [number, NodeJS.Signals | 0][] = [];
  const kill = (pid: number, signal: NodeJS.Signals | 0) => {
    if (!alive.has(pid)) throw new Error("ESRCH");
    if (signal === 0) return;
    signals.push([pid, signal]);
    // The app server ignores SIGTERM, as a busy one can.
    if (signal === "SIGKILL" || pid !== 101) alive.delete(pid);
  };
  const logged: string[] = [];
  await stopE2e({
    dir: wt,
    sh,
    log: (line) => logged.push(line),
    kill,
    sleep: async () => {},
    self: 999,
  });
  assert.deepEqual(signals, [
    [100, "SIGTERM"],
    [101, "SIGTERM"],
    [101, "SIGKILL"],
  ]);
  assert.deepEqual([...alive], [103]);
  assert.match(logged.at(-1)!, /stopped 2 processes/);
});
