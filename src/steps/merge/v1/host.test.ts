import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { blockers, stayAwake, waitForLoad } from "./host.ts";

test("a command the project needs that fails, or gh signed out, blocks the run", () => {
  const ran: string[] = [];
  const sh = (command: string, args: string[]) => {
    ran.push([command, ...args].join(" "));
    const ok = args.at(-1) === "true";
    return { status: ok ? 0 : 1, stdout: "", stderr: "" };
  };
  assert.deepEqual(blockers(process.cwd(), ["true", "docker info"], sh), [
    "`docker info` failed, and the project's checks need it",
    "gh isn't signed in; gh auth login",
  ]);
  assert.deepEqual(ran, ["sh -c true", "sh -c docker info", "gh auth status"]);
});

function fakeStart() {
  const started: string[][] = [];
  let killed = false;
  const start = (command: string, args: string[]) => {
    started.push([command, ...args]);
    return Object.assign(new EventEmitter(), {
      unref: () => {},
      kill: () => (killed = true),
    }) as unknown as ChildProcess;
  };
  return { start, started, killed: () => killed };
}

test("on macOS a run holds caffeinate for as long as its own process lives, and lets go when it ends", () => {
  const { start, started, killed } = fakeStart();
  const lines: string[] = [];
  const release = stayAwake((line) => lines.push(line), "darwin", start);
  assert.deepEqual(started, [["caffeinate", "-dimsu", "-w", String(process.pid)]]);
  assert.match(lines.join("\n"), /holding a no-sleep assertion/);
  assert.equal(killed(), false);
  release();
  assert.equal(killed(), true);
});

test("elsewhere a run holds nothing", () => {
  const { start, started } = fakeStart();
  stayAwake(() => {}, "linux", start)();
  assert.deepEqual(started, []);
});

test("the queue starts at once under LOAD_MAX, waits while over it, and gives up at the limit", async () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const slept: number[] = [];
  const sleep = (ms: number) => {
    slept.push(ms);
    return Promise.resolve();
  };
  await waitForLoad(16, log, { load: () => 3, sleep });
  assert.deepEqual([lines, slept], [[], []]);

  const loads = [20, 18, 9];
  await waitForLoad(16, log, { load: () => loads.shift() ?? 9, sleep, everyMs: 30_000 });
  assert.deepEqual(slept, [30_000, 30_000]);
  assert.match(lines[0] ?? "", /load 20\.0 is over LOAD_MAX 16/);
  assert.match(lines[1] ?? "", /load 9\.0 after 1 min; starting/);

  lines.length = 0;
  await waitForLoad(16, log, { load: () => 30, sleep, everyMs: 60_000, limitMs: 120_000 });
  assert.match(lines.at(-1) ?? "", /load 30\.0 after 2 min; starting anyway/);
});
