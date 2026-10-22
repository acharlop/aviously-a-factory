import type { Exec } from "../runtime/exec.ts";
import { ghJson } from "../runtime/github.ts";
import { parseWorktrees, type Worktree } from "../runtime/worktrees.ts";

export type MergedPr = { number: number; headRefName: string; headRefOid: string };

export type Verdict = { worktree: Worktree; remove: boolean; why: string };

/** Whether `head` is in what the pull request merged; the queue pushes a merge of main onto the branch, so the local head is usually behind it. */
function inMerged(head: string, pr: MergedPr, sh: Exec): boolean {
  if (pr.headRefOid.startsWith(head) || head.startsWith(pr.headRefOid)) return true;
  // --delete-branch removed the branch, so its merged head is only reachable as the pull request's ref.
  sh("git", ["fetch", "--quiet", "origin", `pull/${pr.number}/head`]);
  return sh("git", ["merge-base", "--is-ancestor", head, pr.headRefOid]).status === 0;
}

/** What to do with each worktree but the main one: removed when its branch's merged pull request holds its head and the tree is clean. */
export function plan(
  worktrees: readonly Worktree[],
  merged: readonly MergedPr[],
  sh: Exec,
): Verdict[] {
  return worktrees.slice(1).map((worktree) => {
    const { branch, head, path } = worktree;
    if (!branch) return { worktree, remove: false, why: "no branch checked out" };
    const pr = merged.find((candidate) => candidate.headRefName === branch);
    if (!pr) return { worktree, remove: false, why: "no merged pull request" };
    if (!inMerged(head, pr, sh))
      return {
        worktree,
        remove: false,
        why: `head ${head.slice(0, 8)} has commits #${pr.number} didn't merge`,
      };
    const status = sh("git", ["status", "--porcelain"], { cwd: path });
    if (status.status !== 0) return { worktree, remove: false, why: "git status failed" };
    if (status.stdout.trim() !== "") return { worktree, remove: false, why: "uncommitted changes" };
    return { worktree, remove: true, why: `#${pr.number} merged` };
  });
}

/**
 * `factory clean [--dry-run]` removes the worktrees, then the branches, of merged pull requests,
 * running the project's `foreman.teardown` in each first. A failed teardown is said, not a failed clean.
 */
export function clean(args: readonly string[], teardown: string | undefined, sh: Exec): number {
  const dryRun = args.includes("--dry-run");
  if (args.some((arg) => arg !== "--dry-run")) {
    console.log("usage: factory clean [--dry-run]");
    return 2;
  }
  const list = sh("git", ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) {
    console.error(list.stderr.trim());
    return 1;
  }
  const merged = ghJson<MergedPr[]>(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      "200",
      "--json",
      "number,headRefName,headRefOid",
    ],
    sh,
  );
  let failed = 0;
  for (const { worktree, remove, why } of plan(parseWorktrees(list.stdout), merged, sh)) {
    const name = `${worktree.path} (${worktree.branch ?? "detached"})`;
    if (!remove) console.log(`kept ${name}: ${why}`);
    else if (dryRun) console.log(`would remove ${name}: ${why}`);
    else {
      if (teardown) {
        const down = sh("sh", ["-c", teardown], { cwd: worktree.path });
        if (down.status !== 0)
          console.log(
            `teardown failed in ${worktree.path}: ${down.stderr.trim().split("\n").at(-1)}`,
          );
      }
      const gone = sh("git", ["worktree", "remove", worktree.path]);
      const branch = gone.status === 0 ? sh("git", ["branch", "-D", worktree.branch!]) : gone;
      if (branch.status === 0) console.log(`removed ${name}: ${why}`);
      else {
        failed += 1;
        console.log(`couldn't remove ${name}: ${branch.stderr.trim()}`);
      }
    }
  }
  return failed === 0 ? 0 : 1;
}
