import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";

import { exec } from "./exec.ts";
import { checkSlots, FACTORY_HOME, machineWide } from "./machine.ts";

/** One per machine, whichever project's gate takes it, so two projects' heavy checks never run at once. */
export const HEAVY_LOCK = join(FACTORY_HOME, "locks", "heavy");

/** Where the check slots live, one lock folder per slot. */
export const CHECKS_LOCK = join(FACTORY_HOME, "locks", "checks");

/** Set to the slot a command's checks hold, or `none` when they need none, for every process it starts. */
export const CHECK_SLOT_ENV = "FACTORY_CHECK_SLOT";

/** Started is the process's start time as `ps` reports it, so a reused pid isn't taken for the holder. */
export type Owner = {
  pid: number;
  started?: string;
  command: string;
  cwd: string;
  startedAt: string;
};

export type LockDeps = {
  /** When the process with this pid started, or undefined when there's none. */
  processStart: (pid: number) => string | undefined;
  /** The pid of the process's parent, or undefined when there's none. */
  parent: (pid: number) => number | undefined;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
};

const OWNER = "owner.json";
const POLL_MS = 10_000;
const WAIT_MS = 2 * 60 * 60_000;
const CHECK_WAIT_MS = 20 * 60_000;

/** Who holds the lock, or undefined when it's free. */
export function lockOwner(dir: string): Owner | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, OWNER), "utf8")) as Owner;
  } catch {
    return undefined;
  }
}

export const describeOwner = (owner: Owner | undefined) =>
  owner
    ? `pid ${owner.pid} (\`${owner.command}\` in ${owner.cwd}) since ${owner.startedAt}`
    : "a lock with no owner";

const same = (a: Owner | undefined, b: Owner | undefined) =>
  a?.pid === b?.pid && a?.started === b?.started;

/** Whether the owner's process is still the one that took the lock. */
function alive(owner: Owner, deps: LockDeps): boolean {
  const started = deps.processStart(owner.pid);
  return started !== undefined && (owner.started === undefined || started === owner.started);
}

/** Whether the holder started this process, however many steps up, as the merge queue starts its own checks. */
function heldByAncestor(pid: number, holder: Owner, deps: LockDeps): boolean {
  for (let up = deps.parent(pid); up !== undefined; up = deps.parent(up))
    if (up === holder.pid) return alive(holder, deps);
  return false;
}

/** Whether a process this one descends from holds the lock at dir. */
export function underHolder(dir: string, pid = process.pid, deps = lockDeps): boolean {
  const holder = lockOwner(dir);
  return holder !== undefined && heldByAncestor(pid, holder, deps);
}

/** The live holder a heavy check started from this process would wait for, or undefined when it would go straight through. */
export function blockedBy(dir: string, pid = process.pid, deps = lockDeps): Owner | undefined {
  const holder = lockOwner(dir);
  return holder && alive(holder, deps) && !underHolder(dir, pid, deps) ? holder : undefined;
}

/** Signals a detached child and every process it started, which share its process group. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Makes the lock with its owner file already in it, in one rename, so no one ever sees it ownerless; false when it's taken. */
function claim(dir: string, owner: Owner): boolean {
  const staging = mkdtempSync(`${dir}.claim-${owner.pid}-`);
  writeFileSync(join(staging, OWNER), JSON.stringify(owner));
  try {
    renameSync(staging, dir);
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Removes the staging folders of claims whose process died before it renamed or removed them. */
function sweepClaims(dir: string, deps: LockDeps): void {
  const prefix = `${basename(dir)}.claim-`;
  for (const name of readdirSync(dirname(dir)).filter((name) => name.startsWith(prefix))) {
    const pid = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
    if (pid && deps.processStart(pid) === undefined)
      rmSync(join(dirname(dir), name), { recursive: true, force: true });
  }
}

/** Moves an abandoned lock aside, and back if another process took it over in between; false when it couldn't be moved and is still there. */
function takeOver(dir: string, seen: Owner | undefined, log: (line: string) => void): boolean {
  const aside = `${dir}.abandoned-${process.pid}`;
  try {
    renameSync(dir, aside);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const moved = lockOwner(aside);
  if (moved && !same(moved, seen)) {
    try {
      renameSync(aside, dir);
    } catch {
      log(`machine lock: moved ${describeOwner(moved)}'s lock aside to ${aside} by mistake`);
    }
    return true;
  }
  log(`machine lock: ${describeOwner(seen)} is gone; taking its lock`);
  rmSync(aside, { recursive: true, force: true });
  return true;
}

/** Takes the first free lock of dirs, waiting while live processes hold them all, and gives up after waitMs; returns the release, which leaves a lock someone else took alone. */
async function acquireAny(
  dirs: readonly string[],
  owner: Omit<Owner, "started" | "startedAt">,
  deps: LockDeps,
  waitMs: number,
): Promise<{ dir: string; release: () => void }> {
  for (const dir of dirs) {
    mkdirSync(dirname(dir), { recursive: true });
    sweepClaims(dir, deps);
  }
  const mine: Owner = {
    ...owner,
    started: deps.processStart(owner.pid),
    startedAt: new Date(deps.now()).toISOString(),
  };
  for (let waited = 0; ;) {
    const dir = dirs.find((dir) => claim(dir, mine));
    if (dir)
      return {
        dir,
        release: () => {
          if (same(lockOwner(dir), mine)) rmSync(dir, { recursive: true, force: true });
        },
      };
    const seen = dirs.map((dir) => ({ dir, owner: lockOwner(dir) }));
    const gone = seen.find(({ owner }) => !owner || !alive(owner, deps));
    if (gone && takeOver(gone.dir, gone.owner, deps.log)) continue;
    const holders = seen.map(({ owner }) => describeOwner(owner)).join(", ");
    if (waited >= waitMs)
      throw new Error(
        `machine lock: gave up after ${waitMs / 60_000} minutes waiting for ${holders}; run this again once it's done, or stop it`,
      );
    if (waited === 0) deps.log(`machine lock: waiting for ${holders}`);
    await deps.sleep(POLL_MS);
    waited += POLL_MS;
  }
}

/** Takes the lock, waiting while a live process holds it, and gives up after WAIT_MS; returns the release. */
export async function acquire(
  dir: string,
  owner: Omit<Owner, "started" | "startedAt">,
  deps: LockDeps,
): Promise<() => void> {
  if (underHolder(dir, owner.pid, deps)) return () => {};
  return (await acquireAny([dir], owner, deps, WAIT_MS)).release;
}

export type SlotOptions = {
  slots: number;
  /** The heavy lock: a process its holder started runs its checks under that, so takes no slot. */
  heavy: string;
  env: NodeJS.ProcessEnv;
};

/** Takes one of the check slots under dir, unless a process this one descends from holds one or the heavy lock; the slot taken, or `none`, and its release. Gives up after CHECK_WAIT_MS. */
export async function acquireSlot(
  dir: string,
  owner: Omit<Owner, "started" | "startedAt">,
  deps: LockDeps,
  { slots, heavy, env }: SlotOptions,
): Promise<{ slot: string; release: () => void }> {
  const none = { slot: "none", release: () => {} };
  if (env[CHECK_SLOT_ENV] || underHolder(heavy, owner.pid, deps)) return none;
  const dirs = Array.from({ length: slots }, (_, slot) => join(dir, String(slot)));
  const { dir: slot, release } = await acquireAny(dirs, owner, deps, CHECK_WAIT_MS);
  return { slot, release };
}

const ps = (field: string, pid: number) => {
  const run = exec("ps", ["-o", `${field}=`, "-p", String(pid)]);
  return run.status === 0 ? run.stdout.trim() || undefined : undefined;
};

export const lockDeps: LockDeps = {
  processStart: (pid) => ps("lstart", pid),
  parent: (pid) => Number(ps("ppid", pid)) || undefined,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  log: (line) => console.log(line),
  now: () => Date.now(),
};

/** Takes the lock for this process and the children it starts. */
export const holdLock = (dir: string, command: string, cwd = process.cwd()) =>
  acquire(dir, { pid: process.pid, command, cwd }, lockDeps);

/** Takes a check slot for this process and the children it starts, which it tells through CHECK_SLOT_ENV, and frees it when this process exits; the wait's error when it gives up. */
export async function holdCheckSlot(
  command: string,
  cwd = process.cwd(),
): Promise<string | undefined> {
  try {
    const { slot, release } = await acquireSlot(
      CHECKS_LOCK,
      { pid: process.pid, command, cwd },
      lockDeps,
      { slots: checkSlots(machineWide()), heavy: HEAVY_LOCK, env: process.env },
    );
    process.env[CHECK_SLOT_ENV] ||= slot;
    process.once("exit", release);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Runs the command to the end, under the lock at dir when there is one; its exit code. A signal goes on to the command and everything it started, and the lock is released only once it exits. */
export async function runHeavy(
  command: readonly string[],
  dir: string | undefined,
): Promise<number> {
  // Under the holder, the command stays in the holder's process group, so the holder's signal reaches it once.
  const nested = underHolder(dir ?? HEAVY_LOCK);
  let release = () => {};
  try {
    if (dir) release = await holdLock(dir, command.join(" "));
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  process.once("exit", release);
  const [program = "", ...args] = command;
  const child = spawn(program, args, { stdio: "inherit", detached: !nested });
  const forward = (signal: NodeJS.Signals) => signalGroup(child, signal);
  if (!nested) {
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
  }
  const code = await new Promise<number>((done) => {
    child.on("error", (error) => {
      console.error(`machine lock: ${error.message}`);
      done(1);
    });
    child.on("close", (status, signal) =>
      done(status ?? (signal ? 128 + constants.signals[signal] : 1)),
    );
  });
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);
  release();
  return code;
}
