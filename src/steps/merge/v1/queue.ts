import type { Check, Need, Verdict } from "../../../runtime/checks.ts";
import { type Markers, markerOf } from "../../../runtime/markers.ts";
import type { SignOff } from "../../file/v1/sign-off.ts";
import { removalRefusal, type Removals } from "./removals.ts";

export type Pr = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  enabledAt: string;
  labels: readonly string[];
};

/** A pull request's head with main merged in, and what it needs from each check, by name. */
export type Built = {
  pr: Pr;
  sha: string;
  tree: string;
  needs: ReadonlyMap<string, Need>;
};

/** Why a pull request left the queue: one line for its comment, what to do when it isn't a plain fix, and the detail below it. */
export type Reason = { summary: string; details?: readonly string[]; next?: string };

export type QueueDeps = {
  log: (line: string) => void;
  /** The project's checks, in order. */
  checks: readonly Check[];
  /** Fetches origin; main's sha. */
  fetchMain: () => string;
  /** Open pull requests on main with auto-merge on, the earliest turned on first. */
  queued: () => Pr[];
  /** What keeps GitHub from merging it on review; none when nothing does. */
  reviews: (pr: Pr) => string[];
  /** What the head removes since it forked from main. */
  removals: (pr: Pr, main: string) => Removals;
  /** The head with main merged in, the project's fixups run on the merge, and what it needs; or why it can't be. */
  mergeMain: (pr: Pr, main: string) => Promise<Built | { conflict: string }>;
  /** Main with each built head merged in, in order: the tip, each step's tree, and the heads that conflict with an earlier one. */
  testBranch: (
    main: string,
    built: readonly Built[],
  ) => { tip: string; trees: string[]; left: Built[] };
  /** Runs the check on sha with the units still to settle. */
  runCheck: (
    check: Check,
    sha: string,
    main: string,
    units: readonly string[],
    attempt: number,
  ) => Promise<Verdict>;
  /** Files a check's verdict on the test branch as a sign-off. */
  record: (signOff: SignOff) => void;
  /** Posts the check's status as failed on the pull request's head. */
  failed: (pr: Pr, check: Check, description: string) => void;
  /** Pushes the head to its branch and posts every check's status. */
  land: (built: Built) => Promise<"landed" | "moved" | { failed: string }>;
  /** Merges it: dequeued when auto-merge went off, behind when main moved first, or how it stands when GitHub won't merge it. */
  merged: (pr: Pr) => Promise<"merged" | "dequeued" | "behind" | { stuck: string }>;
  /** Turns auto-merge off and comments why. */
  drop: (pr: Pr, reason: Reason) => void;
  /** Where a pull request stands on GitHub now; undefined when gh can't say. */
  state: (pr: Pr) => "merged" | "closed" | "open" | undefined;
  markers: Markers;
};

// Each round lands, drops or narrows the batch, so this only stops a queue that keeps moving under it.
const MAX_ROUNDS = 20;

const short = (sha: string) => sha.slice(0, 8);
const list = (prs: readonly { number: number }[]) =>
  prs.map(({ number }) => `#${number}`).join(", ");
const links = (prs: readonly { number: number; url: string }[]) =>
  prs.map(({ number, url }) => `[#${number} 🔀](${url})`).join(", ");
const cap = (text: string) => (text.length > 140 ? `${text.slice(0, 139)}…` : text);

export type Round = {
  deps: QueueDeps;
  drop: (pr: Pr, reason: Reason) => void;
  /** Leaves a pull request queued but out of this run, saying why. */
  wait: (pr: Pr, why: string) => void;
  waiting: Set<number>;
  landed: Pr[];
  dropped: Pr[];
  mergedOutside: Pr[];
  /** Signed off by this run, so a merge GitHub makes after the wait gave up still counts as landed. */
  signed: Set<number>;
  seen: Map<number, Pr>;
};

async function buildAll(batch: readonly Pr[], main: string, round: Round): Promise<Built[]> {
  const built: Built[] = [];
  for (const pr of batch) {
    const blockers = round.deps.reviews(pr);
    if (blockers.length > 0) {
      round.wait(
        pr,
        `waits on its review, untested; it rejoins once resolved: ${blockers.join("; ")}`,
      );
      continue;
    }
    const removes = removalRefusal(pr, round.deps.removals(pr, main));
    if (removes) {
      round.drop(pr, removes);
      continue;
    }
    const head = await round.deps.mergeMain(pr, main);
    if ("conflict" in head)
      round.drop(pr, { summary: `it ${head.conflict}`, details: [`main at ${short(main)}`] });
    else built.push(head);
  }
  return built;
}

/** The heads that go on to the test branch: one that needs a check this machine can't run waits for one that can. */
function runnable(built: readonly Built[], round: Round): Built[] {
  return built.filter(({ pr, needs }) => {
    for (const check of round.deps.checks) {
      const need = needs.get(check.name);
      const why = need && check.unavailable?.();
      if (!why) continue;
      const units = need.units.length > 0 ? ` (${need.units.join(", ")})` : "";
      round.wait(pr, `needs ${check.name}${units}, which this machine can't run: ${why}`);
      return false;
    }
    return true;
  });
}

/** A tested pull request's head merged with today's main, or undefined when it can't land this round. */
async function headToLand(
  built: Built,
  trees: readonly string[],
  testedMain: string,
  { deps, drop }: Round,
): Promise<{ pr: Pr; head: Built } | undefined> {
  const main = deps.fetchMain();
  const pr = deps.queued().find(({ number }) => number === built.pr.number);
  if (!pr || pr.headRefOid !== built.pr.headRefOid) {
    const what = pr ? "was pushed to" : "left the queue";
    deps.log(`merge-queue: #${built.pr.number} ${what} after it was tested; starting over`);
    return undefined;
  }
  const head = main === testedMain ? built : await deps.mergeMain(pr, main);
  if ("conflict" in head) {
    drop(pr, { summary: `it ${head.conflict}`, details: [`main at ${short(main)}`] });
    return undefined;
  }
  // The test branch ran exactly this code when a step has its tree; otherwise main moved some other way, and only a new round tests it.
  if (trees.includes(head.tree)) return { pr, head };
  deps.log(
    `merge-queue: main moved to ${short(main)} under #${pr.number}, so the test branch never ran its code; starting a new round`,
  );
  return undefined;
}

/** Pushes and signs off the head, then merges it; false when it didn't merge. */
async function signAndMerge(pr: Pr, head: Built, round: Round): Promise<boolean> {
  const { deps, drop } = round;
  const signed = await deps.land(head);
  if (signed === "moved") {
    deps.log(`merge-queue: #${pr.number}'s branch moved before the push; starting over`);
    return false;
  }
  if (signed !== "landed") {
    drop(pr, { summary: signed.failed, details: [`head ${short(head.sha)}`] });
    return false;
  }
  deps.log(`merge-queue: #${pr.number} signed off; merging it`);
  round.signed.add(pr.number);
  const merged = await deps.merged(pr);
  if (merged === "merged") return true;
  if (merged === "dequeued")
    deps.log(`merge-queue: auto-merge was turned off on #${pr.number}; starting over`);
  else if (merged === "behind")
    deps.log(`merge-queue: main moved before GitHub merged #${pr.number}; starting over`);
  else
    drop(pr, {
      summary: `GitHub didn't merge it after its checks passed (${merged.stuck})`,
      details: [`head ${short(head.sha)}`],
    });
  return false;
}

/** Lands the tested heads one at a time, each merged with the main the one before it made, until one stops the rest. */
async function landAll(
  tested: readonly Built[],
  trees: readonly string[],
  testedMain: string,
  round: Round,
): Promise<void> {
  for (const built of tested) {
    const ready = await headToLand(built, trees, testedMain, round);
    if (!ready || !(await signAndMerge(ready.pr, ready.head, round))) return;
    round.deps.log(`merge-queue: #${ready.pr.number} merged`);
    round.landed.push(ready.pr);
  }
}

/** What a head asks of a check: its units, or the check's own name for one that runs whole. */
const unitsOf = (built: Built, check: Check) => {
  const units = built.needs.get(check.name)?.units ?? [];
  return units.length > 0 ? units : [check.name];
};

/** A check's runs on the tip, each rerunning what failed for the first time or didn't finish: what failed for good (twice, or once with one try), what never settled, what failed once and then passed; or why it couldn't run. */
async function settle(
  check: Check,
  tip: string,
  main: string,
  units: readonly string[],
  round: Round,
) {
  const failedOnce = new Set<string>();
  const failed: string[] = [];
  let pending = units;
  for (let attempt = 0; pending.length > 0 && attempt < check.tries; attempt++) {
    if (attempt > 0)
      round.deps.log(`merge-queue: ${check.name}: ${pending.join(", ")} didn't pass; rerunning`);
    const toRun = pending.filter((unit) => unit !== check.name);
    const run = await round.deps.runCheck(check, tip, main, toRun, attempt);
    if ("unavailable" in run) return run;
    const counts = (unit: string) => failedOnce.has(unit) || check.tries === 1;
    failed.push(...run.failed.filter(counts));
    const first = run.failed.filter((unit) => !counts(unit));
    for (const unit of first) failedOnce.add(unit);
    pending = [...first, ...(run.notRun ?? [])];
  }
  const flaky = [...failedOnce].filter((unit) => !failed.includes(unit) && !pending.includes(unit));
  return { failed, notRun: pending, flaky };
}

/** Runs one check the batch needs on the tip, skipped when its marker already names the tip: true when the batch can go on, after dropping or parking the pull requests whose units didn't pass. */
async function runOnTip(
  check: Check,
  tested: readonly Built[],
  tip: string,
  trees: readonly string[],
  main: string,
  round: Round,
): Promise<boolean> {
  const { deps } = round;
  const needing = tested.filter(({ needs }) => needs.get(check.name));
  if (needing.length === 0) {
    deps.log(`merge-queue: no pull request needs ${check.name}; skipping it`);
    return true;
  }
  const marker = check.marker ? markerOf(check.name) : undefined;
  const record = [tip, ...trees].join(" ");
  if (marker && deps.markers.read(marker)?.split(/\s+/)[0] === tip) {
    deps.log(`merge-queue: ${check.name} already passed on ${short(tip)}; skipping it`);
    // A pass on a test branch tip covers each of its steps, so the record can name them even when the pass came from a run that didn't.
    deps.markers.write(marker, record);
    return true;
  }
  const units = [...new Set(needing.flatMap((built) => unitsOf(built, check)))].sort();
  const named = units.filter((unit) => unit !== check.name);
  deps.log(
    `merge-queue: ${check.name} on ${short(tip)}${named.length > 0 ? `: ${named.join(", ")}` : ""}`,
  );
  const startedAt = new Date();
  const ran = await settle(check, tip, main, units, round);
  const finishedAt = new Date();
  if ("unavailable" in ran) {
    for (const { pr } of needing)
      round.wait(pr, `can't run its ${check.name} here: ${ran.unavailable}`);
    return false;
  }
  const passed = ran.failed.length + ran.notRun.length === 0;
  deps.record({
    outcome: passed ? "passed" : "failed",
    check: check.name,
    sha: tip,
    base: main,
    command: [check.command, ...named].join(" "),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });
  if (passed) {
    deps.log(`merge-queue: ${check.name} passed on ${short(tip)}`);
    if (marker) deps.markers.write(marker, record);
    if (ran.flaky.length > 0) {
      deps.log(`merge-queue: green on retry; flaky: ${ran.flaky.join(", ")}`);
      check.flaky?.(
        ran.flaky.map((unit) => ({
          unit,
          prs: needing
            .filter((built) => unitsOf(built, check).includes(unit))
            .map(({ pr }) => pr.number),
        })),
      );
    }
    return true;
  }
  const whole = named.length === 0;
  for (const built of needing) {
    const own = unitsOf(built, check).filter((unit) => ran.failed.includes(unit));
    if (own.length === 0) continue;
    if (!whole)
      deps.failed(built.pr, check, cap(`${own.join(", ")} failed on main plus this pull request`));
    round.drop(
      built.pr,
      whole
        ? {
            summary: `${check.name} failed on main plus the batch it was tested in`,
            details: [`test branch ${short(tip)}`, `batch: ${links(tested.map((b) => b.pr))}`],
          }
        : {
            summary: `${check.name} failed${check.tries > 1 ? " twice" : ""} on main plus this pull request`,
            details: [...own.map((unit) => `failed: ${unit}`), `test branch ${short(tip)}`],
          },
    );
  }
  const dropped = new Set(round.dropped.map(({ number }) => number));
  for (const built of needing)
    if (
      !dropped.has(built.pr.number) &&
      unitsOf(built, check).some((unit) => ran.notRun.includes(unit))
    )
      round.wait(
        built.pr,
        `its ${check.name} ${ran.notRun.join(", ")} neither passed nor failed for good on ${short(tip)}`,
      );
  return false;
}

/** Builds main plus the batch, runs each check it needs on it, and lands it or drops what failed. */
async function runRound(batch: readonly Pr[], main: string, round: Round): Promise<void> {
  const { deps } = round;
  const built = runnable(await buildAll(batch, main, round), round);
  if (built.length === 0) return;
  const { tip, trees, left } = deps.testBranch(main, built);
  const tested = built.filter((b) => !left.includes(b));
  if (left.length > 0)
    deps.log(
      `merge-queue: ${list(left.map((b) => b.pr))} conflict with an earlier pull request; they wait`,
    );
  deps.log(
    `merge-queue: test branch ${short(tip)} is main ${short(main)} plus ${list(tested.map((b) => b.pr))}`,
  );
  for (const check of deps.checks)
    if (!(await runOnTip(check, tested, tip, trees, main, round))) return;
  await landAll(tested, trees, main, round);
}

/** How a pull request that left the queue ended, and the list that counts it. */
function howItEnded(pr: Pr, { deps, signed, landed, mergedOutside }: Round) {
  const state = deps.state(pr);
  if (state === "merged")
    return signed.has(pr.number)
      ? { how: "merged", into: landed }
      : { how: "merged outside this run", into: mergedOutside };
  return { how: `left the queue, ${state === "open" ? "still open" : (state ?? "state unknown")}` };
}

/** Says how each pull request that left the queue without this run landing or dropping it ended. */
function noteGone(queued: readonly Pr[], round: Round): void {
  const stillQueued = new Set(queued.map(({ number }) => number));
  const { landed, dropped, mergedOutside, seen } = round;
  const counted = new Set([...landed, ...dropped, ...mergedOutside].map(({ number }) => number));
  for (const [number, pr] of seen) {
    if (stillQueued.has(number)) continue;
    round.waiting.delete(number);
    if (counted.has(number)) continue;
    seen.delete(number);
    const { how, into } = howItEnded(pr, round);
    into?.push(pr);
    round.deps.log(`merge-queue: #${number} ${how}`);
  }
  for (const pr of queued) seen.set(pr.number, pr);
}

/** Moves a pull request this run signed off, then dropped when GitHub was slow to merge it, to landed once GitHub has merged it after all. */
function landedAfterAll(round: Round): void {
  for (const pr of round.dropped.filter(({ number }) => round.signed.has(number))) {
    if (round.deps.state(pr) !== "merged") continue;
    round.dropped.splice(round.dropped.indexOf(pr), 1);
    round.landed.push(pr);
    round.deps.log(`merge-queue: #${pr.number} merged after the queue stopped waiting on it`);
  }
}

/** Logs what landed, what merged outside this run and what was dropped. */
export function summarize(round: Round): void {
  landedAfterAll(round);
  const { landed, mergedOutside, dropped, waiting } = round;
  const outside =
    mergedOutside.length > 0 ? ` Merged outside this run: ${list(mergedOutside)}.` : "";
  const waits =
    waiting.size > 0 ? ` Waiting: ${list([...waiting].map((number) => ({ number })))}.` : "";
  round.deps.log(
    `merge-queue: Landed: ${list(landed) || "none"}.${outside} Dropped: ${list(dropped) || "none"}.${waits}`,
  );
}

/** A run's tally before it starts, which the caller keeps so a signal that exits at once can still summarize it. */
export function newRound(deps: QueueDeps): Round {
  const round: Round = {
    deps,
    landed: [],
    dropped: [],
    mergedOutside: [],
    signed: new Set(),
    seen: new Map(),
    waiting: new Set(),
    wait: (pr, why) => {
      deps.log(`merge-queue: #${pr.number} ${why}`);
      round.waiting.add(pr.number);
    },
    drop: (pr, reason) => {
      deps.log(`merge-queue: dropping #${pr.number}: ${reason.summary}`);
      deps.drop(pr, reason);
      round.dropped.push(pr);
    },
  };
  return round;
}

/** Runs the queue until it's empty, and summarizes it however it ends; 1 when the queue kept moving for too many rounds. */
export async function runQueue(deps: QueueDeps, round = newRound(deps)): Promise<number> {
  try {
    for (let n = 1; n <= MAX_ROUNDS; n++) {
      const main = deps.fetchMain();
      const queued = deps.queued();
      noteGone(queued, round);
      const batch = queued.filter(({ number }) => !round.waiting.has(number));
      if (batch.length === 0) {
        deps.log(
          `merge-queue: the queue is empty${queued.length > 0 ? " but for what waits" : ""}.`,
        );
        return 0;
      }
      await runRound(batch, main, round);
    }
    deps.log(`merge-queue: stopped after ${MAX_ROUNDS} rounds; the queue kept changing`);
    return 1;
  } finally {
    summarize(round);
  }
}
