import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runLogged, stopOnSignal } from "./run.ts";

const logIn = (prefix: string) => join(mkdtempSync(join(tmpdir(), prefix)), "run.log");

test("a command that closes stdout and keeps writing to stderr logs both and ends with its exit code", async () => {
  const logFile = logIn("factory-run-");
  const script = "echo early; exec 1>&-; sleep 0.2; echo late >&2; exit 3";
  assert.equal((await runLogged(["sh", "-c", script], logFile)).passed, false);
  assert.equal(readFileSync(logFile, "utf8"), "early\nlate\n");
  assert.deepEqual(await runLogged(["sh", "-c", "echo ok"], logFile), {
    passed: true,
    timedOut: false,
  });
});

test("a command past its timeout is stopped with what it started, and fails even when it exits 0", async () => {
  const started = Date.now();
  const running = runLogged(
    ["sh", "-c", "trap 'exit 0' TERM; sleep 5 & wait"],
    logIn("factory-run-"),
    undefined,
    () => {},
    200,
  );
  assert.deepEqual(await running, { passed: false, timedOut: true });
  assert.ok(Date.now() - started < 4_000);
});

test("a signal goes on to the running command, the next never starts, and the lock is released only once that one exits", async () => {
  let released = 0;
  const exits: number[] = [];
  const guard = stopOnSignal(
    () => released++,
    (code) => exits.push(code),
  );
  const log = logIn("factory-signal-");
  try {
    const running = guard.run(
      ["bash", "-c", "trap 'sleep 0.2; exit 7' TERM; while :; do sleep 0.05; done"],
      log,
    );
    await new Promise((done) => setTimeout(done, 300));
    process.emit("SIGTERM", "SIGTERM");
    assert.equal(released, 0);
    await assert.rejects(running, /stopped by SIGTERM/);
    assert.equal(released, 1);
    await assert.rejects(guard.run(["true"], log), /stopped by SIGTERM/);
    assert.deepEqual(exits, []);
  } finally {
    guard.dispose();
  }
});

test("a signal reaches the processes the running command started, too", async () => {
  const guard = stopOnSignal(
    () => {},
    () => {},
  );
  const dir = mkdtempSync(join(tmpdir(), "factory-grandchild-"));
  const pidFile = join(dir, "pid");
  try {
    const running = guard.run(
      ["bash", "-c", `sleep 30 & echo $! > "${pidFile}"; wait`],
      join(dir, "run.log"),
    );
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    process.emit("SIGTERM", "SIGTERM");
    await assert.rejects(running, /stopped by SIGTERM/);
    await until(() => !exists(grandchild));
  } finally {
    guard.dispose();
  }
});

test("a signal while no command runs releases the lock and exits at once", () => {
  let released = 0;
  const exits: number[] = [];
  const guard = stopOnSignal(
    () => released++,
    (code) => exits.push(code),
  );
  process.emit("SIGINT", "SIGINT");
  guard.dispose();
  assert.equal(released, 1);
  assert.deepEqual(exits, [130]);
});

/** Resolves once fn holds, polling for up to five seconds. */
async function until(fn: () => boolean) {
  for (let waited = 0; !fn(); waited += 50) {
    assert.ok(waited < 5_000, "timed out");
    await new Promise((done) => setTimeout(done, 50));
  }
}

const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
