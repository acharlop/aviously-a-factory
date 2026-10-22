import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { Gate, Merge } from "../../../config/schema.ts";
import type { Fixup } from "../../../modules/registry.ts";
import { type Check, changedFiles, docsOnly, type Need } from "../../../runtime/checks.ts";
import { exec, type Exec } from "../../../runtime/exec.ts";
import { type MachineConfig, timeoutMinutes } from "../../../runtime/machine.ts";
import { gitMarkers } from "../../../runtime/markers.ts";
import { runLogged, type Runner } from "../../../runtime/run.ts";
import { reviewBlockers } from "../../../runtime/reviews.ts";
import { postFailed, postPassed } from "../../../runtime/statuses.ts";
import type { SignOff } from "../../file/v1/sign-off.ts";
import type { Built, Pr, QueueDeps, Reason } from "./queue.ts";
import { removals } from "./removals.ts";

const MERGE_TRIES = 6;
const MERGE_RETRY_MS = 10_000;
/** Set in the queue's own clone, so a run never wipes a checkout it didn't make. */
const MARK = "factory.mergeQueue";
const LOCKFILE = "pnpm-lock.yaml";

type GhPr = Omit<Pr, "enabledAt" | "labels"> & {
  labels: { name: string }[];
  baseRefName: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  autoMergeRequest: { enabledAt: string } | null;
};

const PR_FIELDS =
  "number,title,url,headRefName,headRefOid,labels,baseRefName,isDraft,isCrossRepository,autoMergeRequest";

/** The repo's open pull requests, whatever their base or auto-merge. */
export function listOpen(sh: Exec, cwd: string): GhPr[] {
  const listed = sh(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "100", "--json", PR_FIELDS],
    { cwd },
  );
  if (listed.status !== 0) throw new Error(`gh pr list failed: ${listed.stderr.trim()}`);
  return JSON.parse(listed.stdout) as GhPr[];
}

/** Why an open pull request isn't in the queue, or undefined when it is. */
export function notQueued(pr: GhPr, base: string): string | undefined {
  if (pr.baseRefName !== base) return `targets ${pr.baseRefName}, not ${base}`;
  if (pr.isCrossRepository) return "comes from a fork, which the queue can't push to";
  if (pr.isDraft) return "is a draft";
  if (!pr.autoMergeRequest) return "has auto-merge off";
  return undefined;
}

/** The queue: open pull requests on the base with auto-merge on, the earliest turned on first. */
export function queuedOf(prs: readonly GhPr[], base: string): Pr[] {
  return prs
    .filter((pr) => !notQueued(pr, base))
    .map(({ number, title, url, headRefName, headRefOid, labels, autoMergeRequest }) => ({
      number,
      title,
      url,
      headRefName,
      headRefOid,
      enabledAt: autoMergeRequest!.enabledAt,
      labels: labels.map(({ name }) => name),
    }))
    .sort((a, b) => a.enabledAt.localeCompare(b.enabledAt) || a.number - b.number);
}

/** A push git refused because the branch moved, as opposed to one the pre-push hook failed. */
export const branchMoved = (output: string) =>
  /non-fast-forward|fetch first|stale info|\[rejected\]/.test(output);

export function dropComment(reason: Reason, where: string): string {
  return [
    `Merge queue dropped this: ${reason.summary}. ${reason.next ?? "Fix it, then turn auto-merge back on to queue it again."}`,
    "",
    "<details><summary>For AI</summary>",
    "",
    ...(reason.details ?? []).map((line) => `- ${line}`),
    `- logs: ${where}`,
    "",
    "</details>",
  ].join("\n");
}

type PrView = { state: string; autoMergeRequest: unknown; mergeStateStatus: string };

/** gh's JSON answer, or undefined when it failed or printed something else. */
function ghJson<T>({ status, stdout }: ReturnType<Exec>): T | undefined {
  if (status !== 0) return undefined;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

/** How a pull request the queue merges ended, or undefined while it's still open to merge; offBefore when auto-merge was off on the last look. */
function mergeOutcome(
  now: PrView,
  offBefore: boolean,
): "merged" | "dequeued" | "behind" | undefined {
  if (now.state === "MERGED") return "merged";
  if (now.state === "CLOSED") return "dequeued";
  // GitHub clears auto-merge as it merges, so an open one without it counts only on a second look.
  if (!now.autoMergeRequest) return offBefore ? "dequeued" : undefined;
  return now.mergeStateStatus === "BEHIND" ? "behind" : undefined;
}

const viewMerge = (sh: Exec, dir: string, number: number) =>
  ghJson<PrView>(
    sh("gh", ["pr", "view", String(number), "--json", "state,autoMergeRequest,mergeStateStatus"], {
      cwd: dir,
    }),
  );

/** How a pull request the queue couldn't merge stands, with gh's last refusal. */
const stuckAt = (last: PrView | undefined, refused: string | undefined) =>
  [last ? `${last.state}, ${last.mergeStateStatus}`.toLowerCase() : "unknown", refused]
    .filter(Boolean)
    .join(": ");

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Links each file the clone lacks from the main checkout, replacing a broken link; a line per file saying what it did. */
export function linkFiles(dir: string, main: string, files: readonly string[]): string[] {
  return files.flatMap((file) => {
    const at = join(dir, file);
    const target = join(main, file);
    if (existsSync(at)) return [];
    if (!existsSync(target)) return [`no ${file} in ${main} to link; what needs it will fail`];
    if (isLink(at)) rmSync(at);
    symlinkSync(target, at);
    return [`linked ${file} -> ${target}`];
  });
}

/** Clones the repo for the queue when it isn't there yet, sharing the main checkout's objects while it copies them, and refuses a checkout the queue didn't clone. */
export function ensureClone(
  dir: string,
  main: string,
  links: readonly string[],
  sh: Exec,
  log: (line: string) => void,
): void {
  if (existsSync(join(dir, ".git"))) {
    if (sh("git", ["config", "--local", "--get", MARK], { cwd: dir }).stdout.trim() === "true")
      return;
    throw new Error(
      `${dir} isn't a clone the merge queue made, and a run would wipe its work; point --checkout at a new path`,
    );
  }
  const origin = sh("git", ["remote", "get-url", "origin"], { cwd: main }).stdout.trim();
  log(`merge-queue: cloning ${origin} into ${dir}`);
  const clone = sh("git", [
    "clone",
    "--quiet",
    "--reference-if-able",
    main,
    "--dissociate",
    origin,
    dir,
  ]);
  if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
  if (sh("git", ["config", MARK, "true"], { cwd: dir }).status !== 0)
    throw new Error(`couldn't mark ${dir} as the merge queue's clone`);
  for (const line of linkFiles(dir, main, links)) log(`merge-queue: ${line}`);
}

/** A fixup factory.config.ts runs as a command, with the merge's two sides in its environment; its last line of output is why, when it fails. */
export const commandFixup =
  (command: string, sh: Exec): Fixup =>
  async ({ dir, main, head }) => {
    const ran = sh("env", [`FACTORY_MAIN=${main}`, `FACTORY_HEAD=${head}`, "sh", "-c", command], {
      cwd: dir,
    });
    if (ran.status === 0) return undefined;
    const said = `${ran.stdout}\n${ran.stderr}`.split("\n").filter((line) => line.trim());
    return said.at(-1)?.trim() ?? `\`${command}\` failed`;
  };

type Options = {
  dir: string;
  /** Where each long command's output goes, a file each. */
  runDir: string;
  /** The factory run's folder, whose `<check>.log` gets a copy of every run of that check. */
  checkLogs?: string;
  checks: readonly Check[];
  gate: Gate;
  merge: Merge;
  fixups: readonly Fixup[];
  machine: MachineConfig;
  record: (signOff: SignOff) => void;
  sh?: Exec;
  run?: Runner;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

/** The queue's steps, carried out in the clone at dir, which owns its branch names, so a pull request's branch checked out in a worktree never blocks it. */
export function queueCheckout(options: Options): QueueDeps {
  const { dir, runDir, checkLogs, checks, gate, merge, fixups, machine, log } = options;
  const { sh = exec, run = (c, f, cwd, ms) => runLogged(c, f, cwd, undefined, ms) } = options;
  const { sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = options;
  const git = (...args: string[]) => sh("git", args, { cwd: dir });
  const read = (...args: string[]) => git(...args).stdout.trim();
  const must = (...args: string[]) => {
    const result = git(...args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  let logs = 0;
  const logFile = (name: string) => {
    const file = join(runDir, `${String(++logs).padStart(2, "0")}-${name}.log`);
    log(`merge-queue: ${name}, output in ${file}`);
    return file;
  };
  // Merges dated by their newest parent, so building the same heads again makes the same commits and their markers still count.
  const dated = (args: string[], ...parents: string[]) => {
    const newest = Math.max(
      ...parents.map((sha) => Number(read("log", "-1", "--format=%ct", sha))),
    );
    const date = `${newest} +0000`;
    return sh("env", [`GIT_AUTHOR_DATE=${date}`, `GIT_COMMITTER_DATE=${date}`, "git", ...args], {
      cwd: dir,
    });
  };
  let installedLockfile = "";
  const install = async () => {
    const lockfile = read("hash-object", LOCKFILE);
    if (lockfile === installedLockfile) return true;
    const { passed } = await run(["sh", "-c", merge.install], logFile("install"), dir);
    if (passed) installedLockfile = lockfile;
    return passed;
  };
  /** Checks sha out and installs its dependencies; false when the install fails, which fails what was to run, while a git failure stops the queue. */
  const checkout = async (sha: string, branch?: string) => {
    must("checkout", "--quiet", "--force", ...(branch ? ["-B", branch, sha] : ["--detach", sha]));
    must("clean", "-fdq");
    const installed = await install();
    if (!installed) log(`merge-queue: installing dependencies failed on ${sha.slice(0, 8)}`);
    return installed;
  };
  const abort = (why: string) => {
    git("reset", "--quiet", "--hard");
    git("clean", "-fdq");
    return { conflict: why };
  };
  const fetchHead = (head: string) => {
    if (git("cat-file", "-e", `${head}^{commit}`).status !== 0)
      must("fetch", "--quiet", "origin", head);
  };

  /** What the built head needs from each check: none when it changes only docs. */
  const needsOf = async (pr: Pr, main: string, sha: string) => {
    const files = changedFiles(main, sha, sh, dir);
    const needs = new Map<string, Need>();
    for (const check of checks) {
      const need = docsOnly(files, gate.docs)
        ? undefined
        : await check.needs({ dir, base: main, head: sha, files });
      if (need && "refused" in need) throw new Error(`#${pr.number}: ${need.refused}`);
      needs.set(check.name, need);
    }
    return needs;
  };

  /** The head with main merged in and the project's fixups run on the merge before it's committed; or why it can't be. */
  const mergeMain = async (pr: Pr, main: string): Promise<Built | { conflict: string }> => {
    const head = pr.headRefOid;
    fetchHead(head);
    must("checkout", "--quiet", "--force", "--detach", head);
    must("clean", "-fdq");
    const merge = git("merge", "--no-ff", "--no-commit", "--quiet", main);
    for (const fixup of fixups) {
      const why = await fixup({ dir, main, head });
      if (why) return abort(why);
    }
    const conflicted = read("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (conflicted.length > 0) return abort(`conflicts with main in ${conflicted.join(", ")}`);
    const merging = git("rev-parse", "--verify", "--quiet", "MERGE_HEAD").status === 0;
    if (merge.status !== 0 && !merging)
      return abort(`couldn't merge main: ${merge.stderr.trim() || merge.stdout.trim()}`);
    if (merging) {
      const message = `Merge main into ${pr.headRefName}`;
      const commit = dated(["commit", "--quiet", "-m", message], head, main);
      if (commit.status !== 0) {
        log(
          `merge-queue: committing #${pr.number}'s merge with main failed:\n${commit.stdout}${commit.stderr}`,
        );
        return abort("couldn't commit its merge with main, or its pre-commit hook failed");
      }
    }
    const sha = must("rev-parse", "HEAD");
    // A check's selection can import the project's packages, which a fresh clone hasn't installed yet.
    if (!(await install()))
      log(`merge-queue: installing dependencies failed on ${sha.slice(0, 8)}`);
    const needs = await needsOf(pr, main, sha);
    return { pr, sha, tree: must("rev-parse", "HEAD^{tree}"), needs };
  };
  const builds = new Map<string, Built>();

  return {
    log,
    checks,
    markers: gitMarkers(sh, dir),
    record: options.record,
    fetchMain: () => {
      must("fetch", "--quiet", "--prune", "origin");
      return must("rev-parse", `origin/${gate.base}`);
    },
    queued: () => queuedOf(listOpen(sh, dir), gate.base),
    reviews: (pr) => reviewBlockers(pr.number, (command, args) => sh(command, args, { cwd: dir })),
    removals: (pr, main) => {
      fetchHead(pr.headRefOid);
      return removals(sh, dir, pr.headRefOid, main, merge.removals);
    },
    mergeMain: async (pr, main) => {
      // A fixup can regenerate files with fresh ids each time, so only the first build of a head on a main keeps its markers.
      const key = `${pr.headRefOid} ${main}`;
      const done = builds.get(key);
      if (done) return { ...done, pr };
      const result = await mergeMain(pr, main);
      if (!("conflict" in result)) builds.set(key, result);
      return result;
    },
    testBranch: (main, built) => {
      must("checkout", "--quiet", "--force", "--detach", main);
      must("clean", "-fdq");
      const trees: string[] = [];
      const left: Built[] = [];
      for (const step of built) {
        const merged = dated(
          ["merge", "--quiet", "-m", `Queue PR ${step.pr.number}`, step.sha],
          "HEAD",
          step.sha,
        );
        if (merged.status !== 0) {
          git("merge", "--abort");
          left.push(step);
        } else trees.push(must("rev-parse", "HEAD^{tree}"));
      }
      return { tip: must("rev-parse", "HEAD"), trees, left };
    },
    runCheck: async (check, sha, main, units, attempt) => {
      if (!(await checkout(sha))) return { failed: units.length > 0 ? units : [check.name] };
      const file = logFile(`${check.name}-${sha.slice(0, 8)}`);
      const verdict = await check.run({
        dir,
        base: main,
        sha,
        units,
        attempt,
        logFile: file,
        timeoutMs: timeoutMinutes(machine, check.timeout) * 60_000,
        run,
        log: (line) => log(`merge-queue: ${line}`),
      });
      if (checkLogs && existsSync(file))
        appendFileSync(
          join(checkLogs, `${check.name}.log`),
          `== ${[check.command, ...units].join(" ")}\n${readFileSync(file, "utf8")}\n`,
        );
      return verdict;
    },
    failed: (pr, check, description) => {
      const context = `${gate.status}${check.name}`;
      const failed = postFailed(sh, pr.headRefOid, context, description, undefined, dir);
      if (failed) log(`merge-queue: ${failed}`);
    },
    land: async ({ pr, sha, needs }) => {
      if (!(await checkout(sha, pr.headRefName)))
        return { failed: "installing dependencies failed on main plus this pull request" };
      const pushLog = logFile(`push-${pr.number}`);
      // The pre-push hook skips its checks when the test branch's pass covers this code.
      const push = ["git", "push", "origin", `HEAD:refs/heads/${pr.headRefName}`];
      if (!(await run(push, pushLog, dir)).passed) {
        const output = readFileSync(pushLog, "utf8");
        return branchMoved(output)
          ? "moved"
          : { failed: "the push to its branch failed, or its pre-push hook did" };
      }
      const statuses = checks.map((check) => ({
        name: check.name,
        description: check.describe?.(needs.get(check.name)?.units ?? []) ?? "merge queue",
      }));
      const failed = postPassed(sh, sha, gate.status, statuses, dir);
      return failed ? { failed } : "landed";
    },
    merged: async (pr) => {
      let last: PrView | undefined;
      let refused: string | undefined;
      for (let tries = 0; tries < MERGE_TRIES; tries++) {
        const now = viewMerge(sh, dir, pr.number);
        const outcome = now && mergeOutcome(now, last !== undefined && !last.autoMergeRequest);
        if (outcome) return outcome;
        if (now?.autoMergeRequest) {
          const args = ["pr", "merge", String(pr.number), `--${merge.method}`, "--delete-branch"];
          const merging = sh("gh", args, { cwd: dir });
          if (merging.status === 0) return "merged";
          refused = merging.stderr.trim().split("\n")[0];
        }
        last = now ?? last;
        if (tries < MERGE_TRIES - 1) await sleep(MERGE_RETRY_MS);
      }
      return { stuck: stuckAt(last, refused) };
    },
    state: (pr) => {
      const view = sh("gh", ["pr", "view", String(pr.number), "--json", "state"], { cwd: dir });
      const state = ghJson<{ state?: string }>(view)?.state ?? "";
      return ({ MERGED: "merged", CLOSED: "closed", OPEN: "open" } as const)[state];
    },
    drop: (pr, reason) => {
      const where = `${hostname()}:${runDir}`;
      for (const args of [
        ["pr", "merge", String(pr.number), "--disable-auto"],
        ["pr", "comment", String(pr.number), "--body-file", "-"],
      ]) {
        const result = sh("gh", args, { cwd: dir, input: dropComment(reason, where) });
        if (result.status !== 0)
          log(`merge-queue: gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
      }
    },
  };
}
