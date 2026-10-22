import type { Required } from "./required.ts";

/** One entry of gh's statusCheckRollup: a check run (name, status, conclusion) or a commit status (context, state). */
export type Rollup = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

export type NativePr = {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  isDraft: boolean;
  autoMergeRequest: object | null;
  mergeStateStatus: string;
  statusCheckRollup: Rollup[];
};

export const PR_FIELDS =
  "number,title,url,baseRefName,isDraft,autoMergeRequest,mergeStateStatus,statusCheckRollup";

export type Standing =
  | { action: "update" }
  | { action: "drop"; summary: string; next?: string }
  | { action: "wait"; why: string };

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/** Each reported check by name: passed, failed or still pending. */
function checksOf(rollup: readonly Rollup[]): Map<string, "passed" | "failed" | "pending"> {
  const checks = new Map<string, "passed" | "failed" | "pending">();
  for (const item of rollup) {
    const said = item.conclusion || item.state || "";
    const outcome = PASSED.has(said) ? "passed" : FAILED.has(said) ? "failed" : "pending";
    checks.set(item.name ?? item.context ?? "", outcome);
  }
  return checks;
}

/**
 * What the merge step does with a pull request that has auto-merge on: update it when GitHub needs
 * it up to date with the base, drop it when a required check failed or it conflicts, else wait
 * for GitHub. With no required checks, every reported check counts.
 */
export function standing(pr: NativePr, required: Required, reviews: () => string[]): Standing {
  const base = pr.baseRefName;
  if (pr.mergeStateStatus === "DIRTY")
    return {
      action: "drop",
      summary: `it conflicts with ${base}`,
      next: `Merge ${base} in, push, and turn auto-merge back on.`,
    };
  const checks = checksOf(pr.statusCheckRollup);
  const names = required.checks.length > 0 ? required.checks : [...checks.keys()];
  const failed = names.filter((name) => checks.get(name) === "failed");
  if (failed.length > 0) return { action: "drop", summary: `${failed.join(", ")} failed` };
  if (pr.mergeStateStatus === "BEHIND") return { action: "update" };
  const pending = names.filter((name) => checks.get(name) !== "passed");
  if (pending.length > 0) return { action: "wait", why: `waits on ${pending.join(", ")}` };
  const blockers = pr.mergeStateStatus === "BLOCKED" ? reviews() : [];
  if (blockers.length > 0)
    return { action: "wait", why: `waits on review: ${blockers.join("; ")}` };
  return { action: "wait", why: `checks green; GitHub merges it (${pr.mergeStateStatus})` };
}

/** The pull requests an earlier pass logged in this queue.log as queued and not yet merged. */
export function earlierQueued(log: string): number[] {
  const seen = new Set<number>();
  for (const [, number, rest] of log.matchAll(/merge-queue: #(\d+) (\S+)/g)) {
    if (rest === "merged") seen.delete(Number(number));
    else seen.add(Number(number));
  }
  return [...seen];
}

export type NativeDeps = {
  base: string;
  log: (line: string) => void;
  /** The repo's open pull requests. */
  open: () => NativePr[];
  required: Required;
  /** What keeps GitHub from merging it on review; none when nothing does. */
  reviews: (pr: NativePr) => string[];
  /** Merges the base into its head on GitHub; why it couldn't, or undefined. */
  update: (pr: NativePr) => string | undefined;
  /** Turns auto-merge off and comments why. */
  drop: (pr: NativePr, reason: { summary: string; next?: string }) => void;
  /** Pull requests an earlier pass saw queued. */
  earlier: readonly number[];
  merged: (number: number) => boolean;
  dryRun: boolean;
};

const list = (numbers: readonly number[]) => numbers.map((number) => `#${number}`).join(", ");

const preview = (now: Standing, base: string) =>
  now.action === "update"
    ? `be brought up to date with ${base}`
    : now.action === "drop"
      ? `be dropped: ${now.summary}`
      : `wait: it ${now.why}`;

/** merge@2's pass: says what merged since the last one, then updates, drops or waits on each pull request into the base with auto-merge on. */
export function tend(deps: NativeDeps): number {
  const { base, log } = deps;
  const queued = deps
    .open()
    .filter((pr) => pr.baseRefName === base && !pr.isDraft && pr.autoMergeRequest);
  const still = new Set(queued.map(({ number }) => number));
  const landed = deps.earlier.filter((number) => !still.has(number) && deps.merged(number));
  for (const number of landed) log(`merge-queue: #${number} merged`);
  if (queued.length === 0) log(`merge-queue: no pull request into ${base} has auto-merge on`);
  const dropped: number[] = [];
  const waiting: number[] = [];
  for (const pr of queued) {
    let now = standing(pr, deps.required, () => deps.reviews(pr));
    if (deps.dryRun) {
      log(`merge-queue: #${pr.number} would ${preview(now, base)}`);
      continue;
    }
    if (now.action === "update") {
      const failed = deps.update(pr);
      now = failed
        ? { action: "drop", summary: `it couldn't be brought up to date with ${base}: ${failed}` }
        : {
            action: "wait",
            why: `was behind ${base}; brought it up to date, and its checks run again`,
          };
    }
    if (now.action === "drop") {
      log(`merge-queue: dropping #${pr.number}: ${now.summary}`);
      deps.drop(pr, now);
      dropped.push(pr.number);
    } else {
      log(`merge-queue: #${pr.number} ${now.why}`);
      waiting.push(pr.number);
    }
  }
  const waits = waiting.length > 0 ? ` Waiting: ${list(waiting)}.` : "";
  log(
    `merge-queue: Landed: ${list(landed) || "none"}. Dropped: ${list(dropped) || "none"}.${waits}`,
  );
  return 0;
}

export const dropComment = ({ summary, next }: { summary: string; next?: string }) =>
  `Merge step dropped this: ${summary}. ${next ?? "Fix it, then turn auto-merge back on."}`;
