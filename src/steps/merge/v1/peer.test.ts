import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Exec } from "../../../runtime/exec.ts";
import { holdQueue, type PeerDeps } from "./peer.ts";

/** A machine whose ssh to its peer answers each check in turn: busy, free or unreachable, the last one repeating. */
function mac(host: string, answers: ("busy" | "free" | "unreachable")[]) {
  const dir = mkdtempSync(join(tmpdir(), "factory-peer-"));
  const lines: string[] = [];
  const ssh: string[][] = [];
  const events: string[] = [];
  const status = { busy: 0, free: 1, unreachable: 255 };
  const exec: Exec = (command, args) => {
    assert.equal(command, "ssh");
    ssh.push(args);
    events.push(`ssh ${existsSync(deps.marker) ? "marked" : "unmarked"}`);
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    return {
      status: status[answer],
      stdout: "",
      stderr: answer === "unreachable" ? "timed out" : "",
    };
  };
  const deps: PeerDeps = {
    exec,
    log: (line) => lines.push(line),
    sleep: async (ms) => void events.push(`sleep ${ms}`),
    now: () => new Date("2026-10-19T10:00:00Z"),
    marker: join(dir, "queue"),
    remote: ".factory/app/queue",
    host,
    pid: 4242,
    everyMs: 30_000,
    limitMs: 40 * 60_000,
  };
  let release = () => {};
  const takeLocks = async () => {
    events.push("lock");
    return () => void events.push("unlock");
  };
  const hold = (peer: string | undefined) =>
    holdQueue(peer, takeLocks, (held) => (release = held), deps);
  return {
    deps,
    lines,
    ssh,
    events,
    hold,
    release: () => release(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("with no QUEUE_PEER the queue takes its locks and marker without ssh, and its release removes the marker", async () => {
  const m = mac("office", ["busy"]);
  await m.hold(undefined);
  assert.deepEqual(m.ssh, []);
  assert.deepEqual(JSON.parse(readFileSync(join(m.deps.marker, "owner.json"), "utf8")), {
    host: "office",
    pid: 4242,
    startedAt: "2026-10-19T10:00:00.000Z",
  });
  m.release();
  assert.equal(existsSync(m.deps.marker), false);
  assert.deepEqual(m.events, ["lock", "unlock"]);
  m.cleanup();
});

test("a marker it can't take releases the locks it took before the error", async () => {
  const m = mac("office", ["busy"]);
  const blocker = join(dirname(m.deps.marker), "blocker");
  writeFileSync(blocker, "");
  m.deps.marker = join(blocker, "queue");
  await assert.rejects(m.hold(undefined));
  assert.deepEqual(m.events, ["lock", "unlock"]);
  m.cleanup();
});

test("a busy peer is polled every 30 s, and the queue takes its locks only once the peer's marker is gone", async () => {
  const m = mac("office", ["busy", "busy", "free"]);
  await m.hold("studio");
  assert.deepEqual(m.ssh[0], [
    "-o",
    "ConnectTimeout=5",
    "-o",
    "BatchMode=yes",
    "studio",
    "test",
    "-d",
    ".factory/app/queue",
  ]);
  assert.deepEqual(m.events, [
    "ssh unmarked",
    "sleep 30000",
    "ssh unmarked",
    "sleep 30000",
    "ssh unmarked",
    "lock",
    "ssh marked",
  ]);
  assert.deepEqual(m.lines, ["merge-queue: waiting on studio's queue"]);
  assert.equal(existsSync(m.deps.marker), true);
  m.release();
  m.cleanup();
});

test("a peer marker that outlives TIMEOUT_QUEUE is taken as stale", async () => {
  const m = mac("office", ["busy", "busy", "busy", "free"]);
  m.deps.limitMs = 60_000;
  await m.hold("studio");
  assert.match(m.lines.at(-1)!, /outlived TIMEOUT_QUEUE \(1 min\); taking it as stale/);
  assert.equal(existsSync(m.deps.marker), true);
  m.release();
  m.cleanup();
});

test("a stale peer marker that stays put doesn't make the queue back off from it", async () => {
  const m = mac("office", ["busy"]);
  m.deps.limitMs = 30_000;
  let sleeps = 0;
  // Ends a back-off loop that would otherwise retry forever.
  m.deps.sleep = async (ms) => {
    if (++sleeps > 5) throw new Error("still backing off");
    m.events.push(`sleep ${ms}`);
  };
  await m.hold("studio");
  assert.deepEqual(m.events, ["ssh unmarked", "sleep 30000", "ssh unmarked", "lock"]);
  assert.equal(existsSync(m.deps.marker), true);
  m.release();
  m.cleanup();
});

test("an unreachable peer is a warning, and the queue goes on", async () => {
  const m = mac("office", ["unreachable"]);
  await m.hold("studio");
  assert.deepEqual(m.events, ["ssh unmarked", "lock", "ssh marked"]);
  assert.match(m.lines[0]!, /warning: can't reach studio over ssh \(exit 255: timed out\)/);
  assert.equal(existsSync(m.deps.marker), true);
  m.release();
  m.cleanup();
});

test("both started at once: the host that sorts later removes its marker, frees its locks and waits out the peer", async () => {
  const m = mac("Studio", ["free", "busy", "busy", "free"]);
  await m.hold("office");
  assert.deepEqual(m.events, [
    "ssh unmarked",
    "lock",
    "ssh marked",
    "unlock",
    "ssh unmarked",
    "sleep 30000",
    "ssh unmarked",
    "lock",
    "ssh marked",
  ]);
  assert.deepEqual(m.lines, [
    "merge-queue: office started its queue too; backing off",
    "merge-queue: waiting on office's queue",
  ]);
  m.release();
  m.cleanup();
});

test("both started at once: the host that sorts earlier gives the peer one poll to back off, then runs", async () => {
  const m = mac("office", ["free", "busy", "free"]);
  await m.hold("studio");
  assert.deepEqual(m.events, ["ssh unmarked", "lock", "ssh marked", "sleep 30000", "ssh marked"]);
  assert.deepEqual(m.lines, []);
  assert.equal(existsSync(m.deps.marker), true);
  m.release();
  m.cleanup();
});

test("the host that sorts earlier backs off when the peer's queue was already running", async () => {
  const m = mac("office", ["free", "busy", "busy", "busy", "free"]);
  await m.hold("studio");
  assert.deepEqual(m.lines, [
    "merge-queue: studio's queue was already running; backing off",
    "merge-queue: waiting on studio's queue",
  ]);
  assert.deepEqual(m.events.slice(0, 6), [
    "ssh unmarked",
    "lock",
    "ssh marked",
    "sleep 30000",
    "ssh marked",
    "unlock",
  ]);
  assert.equal(existsSync(m.deps.marker), true);
  m.release();
  m.cleanup();
});

test("a release leaves a marker another run has since taken", async () => {
  const first = mac("office", ["free"]);
  await first.hold(undefined);
  const second = mac("office", ["free"]);
  second.deps.marker = first.deps.marker;
  second.deps.pid = 7;
  await second.hold(undefined);
  first.release();
  assert.equal(existsSync(first.deps.marker), true);
  second.release();
  assert.equal(existsSync(first.deps.marker), false);
  first.cleanup();
  second.cleanup();
});
