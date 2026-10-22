import {
  type Check,
  changedFiles,
  docsOnly,
  type Need,
  type Verdict,
} from "../../../runtime/checks.ts";
import type { Exec } from "../../../runtime/exec.ts";
import { reviewBlockers, reviewRefusal } from "../../../runtime/reviews.ts";
import { postFailed, postPassed } from "../../../runtime/statuses.ts";
import type { Recorder, SignOff } from "../../file/v1/sign-off.ts";

export type Deps = {
  sh: Exec;
  /** The project's checks, in order. */
  checks: readonly Check[];
  /** Globs of files that need no check. */
  docs: readonly string[];
  /** The remote branch changes merge into, such as origin/main. */
  base: string;
  /** Prefix of each check's commit status. */
  status: string;
  /** Whether the check's recorded pass covers sha. */
  passed: (check: string, sha: string) => boolean;
  /** Takes this machine's heavy lock, waiting while someone else holds it; the release. */
  lock: () => Promise<() => void>;
  /** Runs the check on this checkout with the units the branch needs. */
  run: (check: Check, sha: string, units: readonly string[]) => Promise<Verdict>;
  log: (line: string) => void;
  record: Recorder;
};

type Ctx = {
  deps: Deps;
  git: (...args: string[]) => ReturnType<Exec>;
  read: (...args: string[]) => string;
  record: (signOff: Omit<SignOff, "base" | "sha" | "branch">) => string | undefined;
  clean: () => boolean;
  branch: string;
};

type Needs = Map<Check, Need>;
type Failure = { check: string; url?: string };

const short = (sha: string) => sha.slice(0, 8);
const unitList = (need: Need) => (need?.units.length ? ` (${need.units.join(", ")})` : "");

/** Fast-forwards to the pull request's branch when someone moved it on GitHub (an "Update branch" click), so the push after the checks isn't rejected; why not, when the two have diverged. */
function catchUp({ deps, git, read, branch }: Ctx) {
  const remote = `origin/${branch}`;
  if (git("rev-parse", "--verify", "--quiet", remote).status !== 0) return undefined;
  if (git("merge-base", "--is-ancestor", remote, "HEAD").status === 0) return undefined;
  const [head, theirs] = [read("rev-parse", "HEAD"), read("rev-parse", remote)];
  if (git("merge-base", "--is-ancestor", "HEAD", remote).status !== 0)
    return `${branch} (${short(head)}) and ${remote} (${short(theirs)}) have diverged; merge or rebase onto ${remote} by hand and run again`;
  deps.log(`sign-off: fast-forwarding ${branch} to ${remote} (${short(theirs)})`);
  const forward = git("merge", "--ff-only", "--quiet", remote);
  return forward.status === 0
    ? undefined
    : `fast-forwarding to ${remote} failed: ${forward.stderr.trim()}`;
}

/** Why the branch's open pull request can't merge on review yet; undefined when it can, or when there's no pull request. */
function reviewGate(deps: Deps, branch: string): string | undefined {
  const listed = deps.sh("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
  ]);
  if (listed.status !== 0) return `gh pr list failed: ${listed.stderr.trim()}`;
  const [pr] = JSON.parse(listed.stdout || "[]") as { number: number }[];
  if (!pr) return undefined;
  const blockers = reviewBlockers(pr.number, deps.sh);
  return blockers.length > 0 ? reviewRefusal(pr.number, blockers) : undefined;
}

/** Merges the base into the branch when it's behind; why not, when it conflicts. */
function mergeBase({ deps, git, read, branch }: Ctx) {
  const base = read("rev-parse", deps.base);
  if (git("merge-base", "--is-ancestor", base, "HEAD").status === 0) return undefined;
  const into = deps.base.replace(/^origin\//, "");
  deps.log(`sign-off: merging ${into} (${short(base)}) into ${branch}`);
  const merged = git("merge", "--no-ff", "--quiet", "-m", `Merge ${into} into ${branch}`, base);
  if (merged.status === 0) return undefined;
  const conflicted = read("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  git("merge", "--abort");
  return conflicted.length > 0
    ? `${branch} conflicts with ${into} in ${conflicted.join(", ")}; merge ${deps.base} by hand and run again`
    : `merging ${into} into ${branch} failed: ${merged.stderr.trim() || merged.stdout.trim()}`;
}

/** Settles review and merges the base in when the branch is behind; why not, when the branch can't be signed off. */
function prepare(ctx: Ctx): string | undefined {
  const { deps, clean, branch } = ctx;
  if (deps.sh("gh", ["auth", "status"]).status !== 0)
    return "gh isn't installed or signed in; brew install gh, then gh auth login";
  if (!clean()) return "the checkout has uncommitted changes; commit or stash them and run again";
  if (branch === "HEAD" || `origin/${branch}` === deps.base)
    return `sign-off signs off a pull request's branch, not ${branch}; check one out`;
  const unsettled = reviewGate(deps, branch);
  if (unsettled) return unsettled;
  if (ctx.git("fetch", "--quiet", "origin").status !== 0) return "git fetch origin failed";
  return catchUp(ctx) ?? mergeBase(ctx);
}

/** What the branch at sha needs from each check, or why this machine can't sign it off. */
async function needsAt(ctx: Ctx, sha: string): Promise<Needs | { refused: string }> {
  const { deps, read, branch } = ctx;
  const base = read("rev-parse", deps.base);
  const files = changedFiles(base, sha, deps.sh);
  const needs: Needs = new Map();
  const dir = read("rev-parse", "--show-toplevel");
  for (const check of deps.checks) {
    const need = docsOnly(files, deps.docs)
      ? undefined
      : await check.needs({ dir, base, head: sha, files });
    if (need && "refused" in need) return need;
    const why = need && check.unavailable?.();
    if (why)
      return {
        refused: `the branch needs ${check.name}${unitList(need)}, which this machine can't run: ${why}; run \`gh pr checkout ${branch}\` and sign off on one that can`,
      };
    needs.set(check, need);
  }
  return needs;
}

/** Runs each check the branch needs, in order, under the heavy lock; the first that failed, or why one couldn't run. */
async function runChecks(
  ctx: Ctx,
  sha: string,
  needs: Needs,
): Promise<{ failure?: Failure } | { refused: string }> {
  const { deps, record } = ctx;
  const { log } = deps;
  const release = await deps.lock();
  try {
    for (const check of deps.checks) {
      const need = needs.get(check);
      if (!need) {
        log(`sign-off: the changes need no ${check.name} run`);
        record({ outcome: "unaffected", check: check.name });
        continue;
      }
      if (check.marker && deps.passed(check.name, sha)) {
        log(`sign-off: ${check.name} already passed on ${short(sha)}; skipping it`);
        record({ outcome: "gated", check: check.name });
        continue;
      }
      const command = [check.command, ...need.units].join(" ");
      log(`sign-off: ${check.name} running \`${command}\` on ${short(sha)}`);
      const started = new Date();
      const verdict = await deps.run(check, sha, need.units);
      const finished = new Date();
      if ("unavailable" in verdict)
        return { refused: `${check.name} couldn't run: ${verdict.unavailable}` };
      const passed = verdict.failed.length + (verdict.notRun?.length ?? 0) === 0;
      log(`sign-off: ${check.name} ${passed ? "passed" : "FAILED"}`);
      if (need.units.length > 0)
        for (const unit of verdict.failed) log(`sign-off: ${check.name} failed ${unit}`);
      const url = record({
        outcome: passed ? "passed" : "failed",
        check: check.name,
        command,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
      });
      if (!passed) return { failure: { check: check.name, url } };
    }
    return {};
  } finally {
    release();
  }
}

// Each rerun can take a long check, so a base that keeps moving under it stops the sign-off instead.
const MAX_BASE_MOVES = 3;

const sameNeeds = (a: Needs, b: Needs) =>
  [...a].every(([check, need]) => need?.units.join(" ") === b.get(check)?.units.join(" "));

/** Merges the base in again when it moved while the checks ran: the merged head and what it needs, and whether that changed, so the checks run again; undefined when the base didn't move. */
async function catchBase(
  ctx: Ctx,
  tested: string,
  needs: Needs,
): Promise<{ sha: string; needs: Needs; rerun: boolean } | { refused: string } | undefined> {
  const { deps, git, read } = ctx;
  if (git("fetch", "--quiet", "origin").status !== 0) return { refused: "git fetch origin failed" };
  const before = read("rev-parse", "HEAD");
  if (before !== tested)
    return { refused: "HEAD changed while the checks were running; run sign-off again" };
  const conflict = mergeBase(ctx);
  if (conflict) return { refused: conflict };
  const sha = read("rev-parse", "HEAD");
  if (sha === before) return undefined;
  const now = await needsAt(ctx, sha);
  if ("refused" in now) return now;
  const rerun = !sameNeeds(needs, now);
  deps.log(
    rerun
      ? `sign-off: ${deps.base} moved while the checks ran and changes what ${ctx.branch} needs; running them again on ${short(sha)}`
      : `sign-off: ${deps.base} moved while the checks ran, needing the same; the push's pre-push hook checks ${short(sha)}`,
  );
  return { sha, needs: now, rerun };
}

const signer = ({ read }: Ctx) => `factory signoff by ${read("config", "user.name")}`;

/** Pushes the head the checks passed on and posts their statuses; the exit code. */
function publish(ctx: Ctx, sha: string, needs: Needs): number {
  const { deps, git, read, record, clean, branch } = ctx;
  const { log } = deps;
  // A status speaks for the commit the checks ran on, so nothing posts if the checkout moved under them.
  if (read("rev-parse", "HEAD") !== sha || !clean()) {
    log(`sign-off: the checkout changed while the checks ran; nothing posted for ${short(sha)}`);
    record({ outcome: "not-posted", reason: "the checkout changed" });
    return 1;
  }
  const push = git("push", "origin", `HEAD:refs/heads/${branch}`);
  if (push.status !== 0) {
    log(`sign-off: the push to ${branch} failed:\n${push.stdout}${push.stderr}`);
    record({ outcome: "not-posted", reason: "the push failed" });
    return 1;
  }
  const by = signer(ctx);
  const statuses = deps.checks.map((check) => ({
    name: check.name,
    description: check.describe?.(needs.get(check)?.units ?? []) ?? by,
  }));
  const failed = postPassed(deps.sh, sha, deps.status, statuses);
  if (failed) {
    log(`sign-off: ${failed}`);
    record({ outcome: "not-posted", reason: failed });
    return 1;
  }
  const posted = deps.checks.map(({ name }) => `${deps.status}${name}`).join(", ");
  log(`sign-off: ${branch} at ${short(sha)} signed off: ${posted || "no checks"} posted`);
  return 0;
}

/** Marks the pull request's pushed head red for the check that failed, linked to its sign-off; the exit code. */
function reportFailure(ctx: Ctx, sha: string, { check, url }: Failure): number {
  const { deps, git, branch } = ctx;
  // A red head isn't pushed (the pre-push hook would refuse it), so the PR's pushed head carries the status.
  const pushed = git("rev-parse", "--verify", "--quiet", `origin/${branch}`).stdout.trim();
  if (!pushed) {
    deps.log(`sign-off: ${branch} isn't pushed, so no status shows the failure`);
    return 1;
  }
  const description = `${check} failed on ${short(sha)}: ${signer(ctx)}`;
  const failed = postFailed(deps.sh, pushed, `${deps.status}${check}`, description, url);
  deps.log(`sign-off: ${failed ?? `${deps.status}${check} posted as failed on ${short(pushed)}`}`);
  return 1;
}

/** Signs off the checked-out branch on this machine: the base merged in, each check it needs, then a push and every check's status. Returns the exit code: 1 when it refused, a check failed, or the push or a status didn't go through. */
export async function signOff(deps: Deps): Promise<number> {
  const git = (...args: string[]) => deps.sh("git", args);
  const read = (...args: string[]) => git(...args).stdout.trim();
  const branch = read("rev-parse", "--abbrev-ref", "HEAD");
  const at = (sha?: string): Ctx => ({
    deps,
    git,
    read,
    record: (signOff) => deps.record({ ...signOff, branch, sha, base: deps.base }),
    clean: () => read("status", "--porcelain") === "",
    branch,
  });
  const refuse = (ctx: Ctx, reason: string) => {
    deps.log(`sign-off: ${reason}`);
    ctx.record({ outcome: "refused", reason });
    return 1;
  };
  const refused = prepare(at());
  if (refused) return refuse(at(), refused);
  let sha = read("rev-parse", "HEAD");
  let ctx = at(sha);
  let needs = await needsAt(ctx, sha);
  if ("refused" in needs) return refuse(ctx, needs.refused);
  for (let moves = 0; ; moves++) {
    const ran = await runChecks(ctx, sha, needs);
    if ("refused" in ran) return refuse(ctx, ran.refused);
    if (ran.failure) return reportFailure(ctx, sha, ran.failure);
    const moved = await catchBase(ctx, sha, needs);
    if (!moved) return publish(ctx, sha, needs);
    if ("refused" in moved) return refuse(ctx, moved.refused);
    ({ sha, needs } = moved);
    ctx = at(sha);
    if (!moved.rerun) return publish(ctx, sha, needs);
    if (moves + 1 >= MAX_BASE_MOVES)
      return refuse(
        ctx,
        `${deps.base} moved under the checks ${MAX_BASE_MOVES} times; run again later`,
      );
  }
}
