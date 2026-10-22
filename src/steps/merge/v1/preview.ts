import type { Gate, Merge } from "../../../config/schema.ts";
import { exec, type Exec } from "../../../runtime/exec.ts";
import { listOpen, notQueued, queuedOf } from "./checkout.ts";
import type { Pr } from "./queue.ts";
import { removalPreview, removals } from "./removals.ts";

const short = (sha: string) => sha.slice(0, 8);
const list = (prs: readonly { number: number }[]) =>
  prs.map(({ number }) => `#${number}`).join(", ");

/** How a queued pull request's head would merge with main. */
function describeHead(pr: Pr, main: string, cwd: string, merge: Merge, sh: Exec): string {
  const git = (...args: string[]) => sh("git", args, { cwd });
  const head = pr.headRefOid;
  if (git("cat-file", "-e", `${head}^{commit}`).status !== 0)
    git("fetch", "--quiet", "origin", head);
  const merged = git("merge-tree", "--write-tree", "--name-only", "--no-messages", main, head);
  const conflicted = merged.status === 0 ? [] : merged.stdout.trim().split("\n").slice(1);
  const fixups = merge.fixups.length > 0 ? "; the fixups get a try first" : "";
  const result =
    conflicted.length === 0
      ? "merges with main cleanly"
      : `would be dropped: conflicts with main in ${conflicted.join(", ")}${fixups}`;
  let removes: string | undefined;
  try {
    removes = removalPreview(pr, removals(sh, cwd, head, main, merge.removals));
  } catch (error) {
    removes = `couldn't check removals: ${(error as Error).message}`;
  }
  return `#${pr.number} ${pr.title} (${short(head)}, queued ${pr.enabledAt}): ${[result, removes].filter(Boolean).join("; ")}`;
}

/** Prints what a run would do with the open pull requests now, changing nothing but this checkout's fetched refs. */
export function preview(
  cwd: string,
  gate: Gate,
  merge: Merge,
  log: (line: string) => void,
  sh: Exec = exec,
): void {
  const git = (...args: string[]) => sh("git", args, { cwd });
  git("fetch", "--quiet", "origin");
  const main = git("rev-parse", `origin/${gate.base}`).stdout.trim();
  const open = listOpen(sh, cwd);
  log(`merge-queue: ${gate.base} is ${short(main)}; ${open.length} open pull requests`);
  for (const pr of open) {
    const why = notQueued(pr, gate.base);
    if (why) log(`  #${pr.number} ${pr.title}: not queued, ${why}`);
  }
  const queue = queuedOf(open, gate.base);
  if (queue.length === 0) {
    log(
      `merge-queue: nothing is queued (auto-merge on, on ${gate.base}, not a draft); a run would stop here`,
    );
    return;
  }
  for (const pr of queue) log(`  ${describeHead(pr, main, cwd, merge, sh)}`);
  log(
    `merge-queue: would build a test branch of ${gate.base} ${short(main)} plus ${list(queue)}, in that order`,
  );
  const checks = Object.keys(gate.checks);
  log(
    `merge-queue: would run the checks each head needs on it, in order: ${checks.join(", ") || "none configured"}; a check whose marker names the tip is skipped`,
  );
  log(
    `merge-queue: green: for each in turn, merge the latest ${gate.base} (a new round if that isn't code the test branch ran), push, post ${checks.map((name) => `${gate.status}${name}`).join(", ") || "no statuses"}, and ${merge.method}-merge it`,
  );
  log(
    "merge-queue: red: a check with more than one try reruns what failed; what fails for good drops the pull requests that needed it, and a check that runs whole drops the batch",
  );
}
