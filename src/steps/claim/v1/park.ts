import { join } from "node:path";

import type { Exec } from "../../../runtime/exec.ts";
import { parseWorktrees, workingBranch } from "../../../runtime/worktrees.ts";
import { IN_PROGRESS } from "./step.ts";

export type Parking = {
  number: number;
  reason: string;
  /** Where the patch goes: the shift's run folder. */
  runDir: string;
  repo: string;
  /** Who parked it, as person@machine. */
  machine: string;
};

export type Parked = { ok: boolean; said: string[]; comment: string };

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

export const parkName = (branch: string) => `park/${branch.slice(branch.indexOf("/") + 1)}`;

/** The `gh issue edit` arguments that give the claim back and swap the route, so the ticket never carries two. */
export const giveBack = (number: number) => [
  "issue",
  "edit",
  String(number),
  "--remove-assignee",
  "@me",
  "--remove-label",
  IN_PROGRESS,
  "--remove-label",
  "ready-for-agent",
  "--add-label",
  "decision needed",
];

type Git = (...args: string[]) => ReturnType<Exec>;
type Saved = {
  wip: "none" | "committed" | "past the hooks" | "patch only";
  patch?: string;
  said: string[];
};

/** Saves a dirty worktree's work as a patch, then commits it with the hooks, else with `--no-verify`; when the patch can't be read, says so and leaves the work unstaged. */
function saveWork(
  git: Git,
  patch: string,
  url: string,
  write: (file: string, text: string) => void,
): Saved | { failed: string } {
  if (git("status", "--porcelain").stdout.trim() === "") return { wip: "none", said: [] };
  git("add", "-A");
  const diff = git("diff", "--cached", "--binary", "HEAD");
  if (diff.status !== 0) {
    git("reset", "-q");
    return {
      failed: `couldn't save the uncommitted work, so nothing moved: ${lastLine(diff.stderr)}`,
    };
  }
  write(patch, diff.stdout);
  const said = [`saved the uncommitted work to ${patch}`];
  // The reason stays out: a bare #123 in it would fail a commit-msg hook.
  const message = ["-q", "-m", "Parked: work in progress", "-m", url];
  const commit = git("commit", ...message);
  if (commit.status === 0)
    return { wip: "committed", patch, said: [...said, "committed it on the branch, hooks passed"] };
  said.push(`the hooks refused the commit: ${lastLine(commit.stderr)}`);
  // A park branch never merges, so its one commit may skip the hooks rather than lose the work.
  const forced = git("commit", "--no-verify", ...message);
  if (forced.status === 0)
    return { wip: "past the hooks", patch, said: [...said, "committed it with --no-verify"] };
  git("reset", "-q");
  said.push(`couldn't commit it, so it stays uncommitted: ${lastLine(forced.stderr)}`);
  return { wip: "patch only", patch, said };
}

function parkComment(
  { reason, repo, machine }: Parking,
  parked: string,
  saved: Saved,
  pushFailed: string | undefined,
): string {
  const where =
    pushFailed === undefined
      ? `branch [\`${parked}\`](https://github.com/${repo}/tree/${parked})`
      : `branch \`${parked}\`, on ${machine} only: the push failed (${pushFailed})`;
  const lines = [`Parked: ${reason}`, "", `Work: ${where}.`];
  if (saved.wip === "committed") lines.push("Its last commit holds the work that was uncommitted.");
  if (saved.wip === "past the hooks")
    lines.push(
      "Its last commit holds the work that was uncommitted, committed past the hooks: fix what they refused when it resumes.",
    );
  if (saved.wip === "patch only")
    lines.push(
      `Uncommitted work that couldn't be committed: \`${saved.patch}\` on ${machine}, and still in its worktree (\`git apply\` it onto the branch).`,
    );
  return lines.join("\n");
}

/** Parks the ticket's branch, its worktree's uncommitted work first; every step that fails is said, and the work stays where it is. */
export function park(
  parking: Parking,
  sh: Exec,
  write: (file: string, text: string) => void,
): Parked {
  const { number, runDir, repo } = parking;
  const branches = sh("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const branch = workingBranch(branches.stdout.trim().split("\n"), number);
  if (!branch)
    return { ok: false, said: [`no <department>/${number}-<slug> branch here`], comment: "" };
  const parked = parkName(branch);
  const cwd = parseWorktrees(sh("git", ["worktree", "list", "--porcelain"]).stdout).find(
    (worktree) => worktree.branch === branch,
  )?.path;
  const git: Git = (...args) => sh("git", args, cwd === undefined ? {} : { cwd });

  const patch = join(runDir, `${parked.replace("/", "-")}.patch`);
  const url = `https://github.com/${repo}/issues/${number}`;
  const saved = cwd ? saveWork(git, patch, url, write) : { wip: "none" as const, said: [] };
  if ("failed" in saved) return { ok: false, said: [saved.failed], comment: "" };
  const said = [...saved.said];

  const rename = git("branch", "-m", branch, parked);
  if (rename.status !== 0)
    return {
      ok: false,
      said: [...said, `couldn't rename ${branch}: ${lastLine(rename.stderr)}`],
      comment: "",
    };
  said.push(`renamed ${branch} to ${parked}`);

  const push = git("push", "--no-verify", "-u", "origin", parked);
  const pushFailed = push.status === 0 ? undefined : lastLine(push.stderr);
  said.push(
    pushFailed === undefined ? `pushed ${parked}` : `couldn't push ${parked}: ${pushFailed}`,
  );
  const comment = parkComment(parking, parked, saved, pushFailed);
  return { ok: pushFailed === undefined && saved.wip !== "patch only", said, comment };
}
