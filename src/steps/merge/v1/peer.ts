import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import { exec, type Exec } from "../../../runtime/exec.ts";
import { machine } from "../../../runtime/github.ts";

const OWNER = "owner.json";

export type PeerDeps = {
  exec: Exec;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** This machine's queue marker, held for the whole run. */
  marker: string;
  /** The peer's marker as ssh finds it there, from its home folder. */
  remote: string;
  /** This machine's short host name. */
  host: string;
  pid: number;
  everyMs: number;
  /** How long to wait on the peer's marker before taking it as stale. */
  limitMs: number;
};

/** The project's queue marker on this machine, `queue` in its folder under ~/.factory, which QUEUE_PEER checks over ssh so two machines never run the project's queue at once. */
export const peerDeps = (
  log: (line: string) => void,
  limitMs: number,
  marker: string,
): PeerDeps => ({
  exec,
  log,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  marker,
  remote: relative(homedir(), marker),
  host: machine(),
  pid: process.pid,
  everyMs: 30_000,
  limitMs,
});

/** Whether the peer's queue marker is there: busy, free, or unreachable when ssh can't say. */
function peerState(peer: string, deps: PeerDeps): "busy" | "free" | "unreachable" {
  const ssh = ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", peer, "test", "-d", deps.remote];
  const { status, stderr } = deps.exec("ssh", ssh);
  if (status === 0) return "busy";
  if (status === 1) return "free";
  deps.log(
    `merge-queue: warning: can't reach ${peer} over ssh (exit ${status}: ${stderr.trim()}); going on without its queue`,
  );
  return "unreachable";
}

/** Waits while the peer's queue runs, up to the limit, after which its marker is taken as stale; whether it was. */
async function waitForPeer(peer: string, deps: PeerDeps): Promise<boolean> {
  if (peerState(peer, deps) !== "busy") return false;
  deps.log(`merge-queue: waiting on ${peer}'s queue`);
  for (let waited = 0; waited < deps.limitMs; waited += deps.everyMs) {
    await deps.sleep(deps.everyMs);
    if (peerState(peer, deps) !== "busy") return false;
  }
  deps.log(
    `merge-queue: ${peer}'s queue marker outlived TIMEOUT_QUEUE (${deps.limitMs / 60_000} min); taking it as stale and starting`,
  );
  return true;
}

/** Takes this machine's marker, replacing one a killed run left, since the heavy lock already keeps a second queue off this machine; its release. */
function takeMarker(deps: PeerDeps): () => void {
  mkdirSync(dirname(deps.marker), { recursive: true });
  rmSync(deps.marker, { recursive: true, force: true });
  mkdirSync(deps.marker);
  const owner = { host: deps.host, pid: deps.pid, startedAt: deps.now().toISOString() };
  writeFileSync(join(deps.marker, OWNER), `${JSON.stringify(owner)}\n`);
  return () => {
    try {
      const holder = JSON.parse(readFileSync(join(deps.marker, OWNER), "utf8")) as typeof owner;
      if (holder.pid !== deps.pid) return;
    } catch {
      return;
    }
    rmSync(deps.marker, { recursive: true, force: true });
  };
}

/** Whether this machine backs off after taking its marker: the later host at once when both started together, the earlier one only when the peer's marker outlives its own back-off. */
async function backOff(peer: string, deps: PeerDeps): Promise<boolean> {
  if (peerState(peer, deps) !== "busy") return false;
  if (deps.host.toLowerCase() > peer.toLowerCase()) {
    deps.log(`merge-queue: ${peer} started its queue too; backing off`);
    return true;
  }
  await deps.sleep(deps.everyMs);
  if (peerState(peer, deps) !== "busy") return false;
  deps.log(`merge-queue: ${peer}'s queue was already running; backing off`);
  return true;
}

/** Waits out the peer's queue, takes the locks and this machine's marker, and backs off and retries when the peer started at the same time. Held gets each release as it changes, so a signal mid-wait frees what's held. */
export async function holdQueue(
  peer: string | undefined,
  takeLocks: () => Promise<() => void>,
  held: (release: () => void) => void,
  deps: PeerDeps,
): Promise<void> {
  for (;;) {
    const stale = peer ? await waitForPeer(peer, deps) : false;
    const unlock = await takeLocks();
    let unmark: () => void;
    try {
      unmark = takeMarker(deps);
    } catch (error) {
      unlock();
      throw error;
    }
    const release = () => (unmark(), unlock());
    held(release);
    // A stale marker still answers busy, so backing off from it would retry forever.
    if (!peer || stale || !(await backOff(peer, deps))) return;
    release();
    held(() => {});
  }
}
