import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The project's run lock on this machine, `lock` in its folder under ~/.factory: a folder with the holder's `pid` and `step`, which shifts take and the queue takes when no shift holds it. */
export const runLockOf = (projectHome: string) => join(projectHome, "lock");

/** Takes the lock for step when no one holds it, and returns its release, which removes it only when this took it; a shift already holding it keeps it. */
export function takeRunLock(step: string, lock: string, pid = process.pid): () => void {
  try {
    mkdirSync(lock);
  } catch {
    return () => {};
  }
  writeFileSync(join(lock, "pid"), `${pid}\n`);
  writeFileSync(join(lock, "step"), `${step}\n`);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const pidFile = join(lock, "pid");
    const holder = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : undefined;
    if (holder === String(pid)) rmSync(lock, { recursive: true, force: true });
  };
}

/** The release of another lock, extended to take the run lock for step meanwhile. */
export function withRunLock(step: string, lock: string, release: () => void): () => void {
  const unlock = takeRunLock(step, lock);
  return () => (release(), unlock());
}
