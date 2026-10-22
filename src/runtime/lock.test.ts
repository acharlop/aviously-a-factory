import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  acquire,
  acquireSlot,
  blockedBy,
  CHECK_SLOT_ENV,
  HEAVY_LOCK,
  type LockDeps,
  lockDeps,
  lockOwner,
  runHeavy,
} from "./lock.ts";

const lockDir = () => join(mkdtempSync(join(tmpdir(), "machine-lock-test-")), "locks", "heavy");
const me = (pid: number) => ({ pid, command: "pnpm test:e2e", cwd: "/repo" });

/** Processes by pid, each with the time it started. */
function deps(
  running: Map<number, string>,
  { onSleep = () => {}, parents = new Map<number, number>() } = {},
) {
  const lines: string[] = [];
  let sleeps = 0;
  const lock: LockDeps = {
    processStart: (pid) => running.get(pid),
    sleep: async () => {
      sleeps++;
      onSleep();
    },
    log: (line) => lines.push(line),
    now: () => Date.UTC(2026, 9, 12, 9),
    parent: (pid) => parents.get(pid),
  };
  return { lock, lines, sleeps: () => sleeps };
}

const running = (...pids: number[]) => new Map(pids.map((pid) => [pid, `start of ${pid}`]));

test("a free lock is taken at once, names its owner, leaves nothing beside it, and is gone once released", async () => {
  const dir = lockDir();
  const { lock, sleeps } = deps(running(1));
  const release = await acquire(dir, me(1), lock);
  assert.deepEqual(lockOwner(dir), {
    ...me(1),
    started: "start of 1",
    startedAt: "2026-10-12T09:00:00.000Z",
  });
  assert.equal(sleeps(), 0);
  assert.deepEqual(readdirSync(dirname(dir)), ["heavy"]);
  release();
  assert.ok(!existsSync(dir));
});

test("taking the lock clears the claim folders a dead process left beside it, and keeps a live one's", async () => {
  const dir = lockDir();
  mkdirSync(`${dir}.claim-7-abc123`, { recursive: true });
  mkdirSync(`${dir}.claim-2-def456`);
  writeFileSync(join(`${dir}.claim-2-def456`, "owner.json"), JSON.stringify(me(2)));
  const release = await acquire(dir, me(1), deps(running(1, 2)).lock);
  assert.deepEqual(readdirSync(dirname(dir)).sort(), ["heavy", "heavy.claim-2-def456"]);
  release();
});

test("a lock a live process holds is waited for, saying who holds it once", async () => {
  const dir = lockDir();
  const alive = running(1, 2);
  const first = await acquire(dir, me(1), deps(alive).lock);
  let waits = 0;
  const second = deps(alive, {
    onSleep: () => {
      if (++waits === 3) first();
    },
  });
  await acquire(dir, me(2), second.lock);
  assert.equal(second.sleeps(), 3);
  assert.equal(lockOwner(dir)?.pid, 2);
  assert.equal(second.lines.length, 1);
  assert.match(second.lines[0]!, /waiting for pid 1 \(`pnpm test:e2e` in \/repo\)/);
});

test("a lock whose holder died, whose pid now belongs to another process, or with no owner is taken over", async () => {
  const dir = lockDir();
  await acquire(dir, me(1), deps(running(1)).lock);
  const taker = deps(running(2));
  await acquire(dir, me(2), taker.lock);
  assert.equal(lockOwner(dir)?.pid, 2);
  assert.match(taker.lines.join("\n"), /pid 1 .* is gone; taking its lock/);

  const reused = new Map([
    [2, "a later start"],
    [3, "start of 3"],
  ]);
  await acquire(dir, me(3), deps(reused).lock);
  assert.equal(lockOwner(dir)?.pid, 3);

  const ownerless = lockDir();
  mkdirSync(ownerless, { recursive: true });
  await acquire(ownerless, me(4), deps(running(4)).lock);
  assert.equal(lockOwner(ownerless)?.pid, 4);
});

test("a lock still held after the wait gives up, naming the holder", async () => {
  const dir = lockDir();
  await acquire(dir, me(1), deps(running(1, 2)).lock);
  const waiter = deps(running(1, 2));
  await assert.rejects(
    acquire(dir, me(2), waiter.lock),
    /gave up after 120 minutes waiting for pid 1 \(`pnpm test:e2e` in \/repo\)/,
  );
  assert.equal(waiter.sleeps(), 720);
  assert.equal(lockOwner(dir)?.pid, 1);
});

test("a process the holder started, however far down, goes through the lock it holds and leaves it held", async () => {
  const dir = lockDir();
  await acquire(dir, me(1), deps(running(1, 2)).lock);
  const child = deps(running(1, 2, 3), {
    parents: new Map([
      [3, 2],
      [2, 1],
    ]),
  });
  const release = await acquire(dir, me(3), child.lock);
  assert.equal(child.sleeps(), 0);
  release();
  assert.equal(lockOwner(dir)?.pid, 1);
});

test("a gate would wait only for a live holder that didn't start it", async () => {
  const dir = lockDir();
  assert.equal(blockedBy(dir, 3, deps(running(3)).lock), undefined);
  await acquire(dir, me(1), deps(running(1)).lock);
  assert.equal(blockedBy(dir, 3, deps(running(1, 3)).lock)?.pid, 1);
  assert.equal(blockedBy(dir, 3, deps(running(3)).lock), undefined);
  const descendant = deps(running(1, 3), { parents: new Map([[3, 1]]) });
  assert.equal(blockedBy(dir, 3, descendant.lock), undefined);
});

test("releasing a lock someone else has since taken leaves theirs alone", async () => {
  const dir = lockDir();
  const release = await acquire(dir, me(1), deps(running(1)).lock);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...me(2), startedAt: "" }));
  release();
  assert.equal(lockOwner(dir)?.pid, 2);
});

test("a process's start time is read for a live pid, and there is none for a dead one", () => {
  const { processStart, parent } = lockDeps;
  assert.ok(processStart(process.pid));
  assert.equal(processStart(2 ** 22 + 1), undefined);
  assert.equal(parent(process.pid), process.ppid);
});

test("a heavy gate holds the lock until its command exits, hands a signal on to it, and exits with its code", async () => {
  const dir = lockDir();
  const script = `trap 'exit 7' TERM; [ -e "${dir}/owner.json" ] || exit 1; while :; do sleep 0.05; done`;
  const run = runHeavy(["bash", "-c", script], dir);
  await new Promise((done) => setTimeout(done, 500));
  assert.equal(lockOwner(dir)?.pid, process.pid);
  process.emit("SIGTERM", "SIGTERM");
  assert.equal(await run, 7);
  assert.ok(!existsSync(dir));
});

test("a run given no lock goes straight to its command and never takes the heavy lock", async () => {
  const run = runHeavy(["bash", "-c", "sleep 0.3"], undefined);
  await new Promise((done) => setTimeout(done, 100));
  assert.notEqual(lockOwner(HEAVY_LOCK)?.pid, process.pid);
  assert.equal(await run, 0);
});

const slotsDir = () => join(mkdtempSync(join(tmpdir(), "machine-lock-test-")), "locks", "checks");
const check = (pid: number) => ({ pid, command: "pnpm verify:web", cwd: `/repo-${pid}` });
const slotOptions = (dir: string, env: NodeJS.ProcessEnv = {}) => ({
  slots: 2,
  heavy: join(dirname(dir), "heavy"),
  env,
});

test("two checks take the two slots, and a third waits, naming both holders once, until one is done", async () => {
  const dir = slotsDir();
  const alive = running(1, 2, 3);
  const first = await acquireSlot(dir, check(1), deps(alive).lock, slotOptions(dir));
  const second = await acquireSlot(dir, check(2), deps(alive).lock, slotOptions(dir));
  assert.notEqual(first.slot, second.slot);
  let waits = 0;
  const third = deps(alive, {
    onSleep: () => {
      if (++waits === 2) second.release();
    },
  });
  const taken = await acquireSlot(dir, check(3), third.lock, slotOptions(dir));
  assert.equal(third.sleeps(), 2);
  assert.equal(taken.slot, second.slot);
  assert.equal(lockOwner(taken.slot)?.pid, 3);
  assert.equal(lockOwner(first.slot)?.pid, 1);
  assert.equal(third.lines.length, 1);
  assert.match(third.lines[0]!, /waiting for pid 1 \(`pnpm verify:web` in \/repo-1\).*, pid 2 /);
});

test("a check whose holder died frees its slot for the next one at once", async () => {
  const dir = slotsDir();
  await acquireSlot(dir, check(1), deps(running(1)).lock, slotOptions(dir));
  await acquireSlot(dir, check(2), deps(running(1, 2)).lock, slotOptions(dir));
  const next = deps(running(2, 3));
  const taken = await acquireSlot(dir, check(3), next.lock, slotOptions(dir));
  assert.equal(next.sleeps(), 0);
  assert.equal(lockOwner(taken.slot)?.pid, 3);
  assert.match(next.lines.join("\n"), /pid 1 .* is gone; taking its lock/);
});

test("a check started inside one that holds a slot takes no second slot, even with every slot taken", async () => {
  const dir = slotsDir();
  const alive = running(1, 2, 3);
  const outer = await acquireSlot(dir, check(1), deps(alive).lock, slotOptions(dir));
  await acquireSlot(dir, check(2), deps(alive).lock, slotOptions(dir));
  const nested = deps(alive);
  const inner = await acquireSlot(
    dir,
    check(3),
    nested.lock,
    slotOptions(dir, { [CHECK_SLOT_ENV]: outer.slot }),
  );
  assert.equal(inner.slot, "none");
  assert.equal(nested.sleeps(), 0);
  inner.release();
  assert.equal(lockOwner(outer.slot)?.pid, 1);
  assert.deepEqual(readdirSync(dir).sort(), ["0", "1"]);
});

test("a check the heavy lock's holder started takes no slot, even with every slot taken", async () => {
  const dir = slotsDir();
  const { heavy } = slotOptions(dir);
  await acquire(heavy, me(1), deps(running(1)).lock);
  await acquireSlot(dir, check(2), deps(running(2)).lock, slotOptions(dir));
  await acquireSlot(dir, check(4), deps(running(2, 4)).lock, slotOptions(dir));
  const queue = deps(running(1, 2, 3, 4), { parents: new Map([[3, 1]]) });
  const taken = await acquireSlot(dir, check(3), queue.lock, slotOptions(dir));
  assert.equal(taken.slot, "none");
  assert.equal(queue.sleeps(), 0);
});

test("a check still waiting after 20 minutes gives up, naming the holders", async () => {
  const dir = slotsDir();
  const alive = running(1, 2, 3);
  await acquireSlot(dir, check(1), deps(alive).lock, slotOptions(dir));
  await acquireSlot(dir, check(2), deps(alive).lock, slotOptions(dir));
  const waiter = deps(alive);
  await assert.rejects(
    acquireSlot(dir, check(3), waiter.lock, slotOptions(dir)),
    /gave up after 20 minutes waiting for pid 1 \(`pnpm verify:web` in \/repo-1\).*, pid 2 \(`pnpm verify:web` in \/repo-2\)/,
  );
  assert.equal(waiter.sleeps(), 120);
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

test("a signal to a heavy gate reaches the processes its command started, too", async () => {
  const dir = lockDir();
  const pidFile = join(mkdtempSync(join(tmpdir(), "machine-lock-grandchild-")), "pid");
  const run = runHeavy(["bash", "-c", `sleep 30 & echo $! > "${pidFile}"; wait`], dir);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(exists(grandchild));
  process.emit("SIGTERM", "SIGTERM");
  assert.equal(await run, 143);
  await until(() => !exists(grandchild));
});
