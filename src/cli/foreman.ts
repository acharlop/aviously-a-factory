import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadProject } from "../config/load.ts";
import { exec, type Exec } from "../runtime/exec.ts";
import { gh, ghJson, machine, repoName, searchIssues, who } from "../runtime/github.ts";
import { runFolder, shiftCount } from "../runtime/machine.ts";
import { parseWorktrees } from "../runtime/worktrees.ts";
import { type OpenPr as ResumePr, nextStep, ticketState } from "../shift/resume.ts";
import { PR_BODY } from "../steps/build/v1/step.ts";
import {
  claim as claimTicket,
  type Claimed,
  inFlight as splitClaims,
  type MergedPr,
} from "../steps/claim/v1/claim.ts";
import {
  CANDIDATE_FIELDS,
  type Candidate,
  freeTickets,
  namedOnMain,
  type OpenPr,
  type Order,
  ORDERS,
  orderLine,
} from "../steps/claim/v1/free.ts";
import { giveBack, park as parkTicket } from "../steps/claim/v1/park.ts";
import { IN_PROGRESS } from "../steps/claim/v1/step.ts";
import { localDate } from "../steps/file/v1/record.ts";
import { axesFor, INSPECTORS } from "../steps/quality-control/v1/step.ts";
import { parseArgs, push as pushBranch, USAGE as PUSH_USAGE } from "../steps/rework/v1/push.ts";

const project = (sh: Exec) => repoName(sh).split("/")[1]!;

/** The value after each `flag` in args, and the args with them taken out; undefined when a flag has no value. */
export function takeFlag(args: readonly string[], flag: string) {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) rest.push(args[i]!);
    else if (args[i + 1] === undefined || args[i + 1]!.startsWith("--")) return undefined;
    else values.push(args[++i]!);
  }
  return { values, rest };
}

/** The `--run-dir` named, else today's run folder on this machine. */
function runDir(args: readonly string[], sh: Exec) {
  const taken = takeFlag(args, "--run-dir");
  if (!taken || taken.values.length > 1) return undefined;
  const dir = taken.values[0] ?? runFolder(project(sh), localDate(new Date()));
  return { dir: resolve(dir), rest: taken.rest };
}

const FREE_USAGE =
  "usage: factory free [--department <name>]... [--kind <kind>]... [--order priority|fifo|lifo|alternate] [--mobile]";

/** `factory free`: the free tickets the filter admits, one `<number>\t<kind>\t<title>` a line, in the order the shift takes them. */
export async function free(args: string[], sh: Exec = exec): Promise<number> {
  const departments = takeFlag(args, "--department");
  const kinds = departments && takeFlag(departments.rest, "--kind");
  const order = kinds && takeFlag(kinds.rest, "--order");
  const rest = order?.rest.filter((arg) => arg !== "--mobile");
  const picked = (order?.values.at(-1) ?? "priority") as Order;
  if (!rest || rest.length > 0 || !ORDERS.includes(picked)) {
    console.log(FREE_USAGE);
    return 2;
  }
  const resolved = await loadProject();
  const device =
    resolved.modules.mobile === "none" ? undefined : resolved.modules.mobile.department;
  const wanted = [...departments!.values];
  if (args.includes("--mobile")) {
    if (!device) {
      console.log("the mobile module is none in factory.config.ts");
      return 1;
    }
    wanted.push(device);
  }
  const repo = repoName(sh);
  const candidates = searchIssues<Candidate>(
    `repo:${repo} is:issue is:open label:ready-for-agent`,
    CANDIDATE_FIELDS,
    sh,
  );
  const openPrs = ghJson<OpenPr[]>(
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,headRefName"],
    sh,
  );
  const { base } = resolved.gate;
  if (sh("git", ["fetch", "--quiet", "origin", base]).status !== 0)
    throw new Error(`git fetch origin ${base} failed`);
  const log = sh("git", ["log", `origin/${base}`, "--format=%B"]).stdout;
  const shift = shiftCount(repo.split("/")[1]!);
  console.log(orderLine(picked, shift));
  const filter = { departments: wanted, kinds: kinds!.values };
  for (const issue of freeTickets(candidates, openPrs, namedOnMain(log), {
    filter,
    order: picked,
    shift,
    ...(device && { device }),
  })) {
    const kind = issue.labels.nodes.find(({ name }) => name.startsWith("kind:"))?.name.slice(5);
    console.log(`${issue.number}\t${kind ?? "-"}\t${issue.title}`);
  }
  return 0;
}

/** `factory claim <n> <branch>`: claims a free ticket for the branch on this machine. */
export async function claim([n, branch, ...rest]: string[], sh: Exec = exec): Promise<number> {
  const number = Number(n);
  if (!Number.isInteger(number) || number <= 0 || !branch || rest.length > 0) {
    console.log("usage: factory claim <n> <department>/<n>-<slug>");
    return 2;
  }
  if (!branch.includes(`/${number}-`)) {
    console.log(`${branch} isn't a <department>/${number}-<slug> branch`);
    return 2;
  }
  const claimed = claimTicket({ number, branch, machine: machine(), repo: repoName(sh) }, sh);
  console.log(claimed.said);
  return claimed.ok ? 0 : 1;
}

/**
 * `factory in-flight [--run-dir <path>]`: this gh login's claims whose branch is here, one
 * `<number>\t<title>\t<branch>\t<next step>` a line; stale and other machines' claims go to stderr.
 */
export async function inFlight(args: string[], sh: Exec = exec): Promise<number> {
  const run = runDir(args, sh);
  if (!run || run.rest.length > 0) {
    console.log("usage: factory in-flight [--run-dir <path>]");
    return 2;
  }
  const claimed = ghJson<Claimed[]>(
    [
      "issue",
      "list",
      "--state",
      "open",
      "--assignee",
      "@me",
      "--label",
      IN_PROGRESS,
      "--limit",
      "200",
      "--json",
      "number,title,comments",
    ],
    sh,
  );
  const prs = <T>(state: string, fields: string) =>
    ghJson<T[]>(
      [
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        "200",
        "--json",
        `number,title,body,headRefName${fields}`,
      ],
      sh,
    );
  const open = prs<OpenPr & ResumePr>("open", ",url,autoMergeRequest");
  const here = (branch: string) => sh("git", ["branch", "--list", branch]).stdout.trim() !== "";
  const split = splitClaims(claimed, open, prs<MergedPr>("merged", ",url,mergedAt"), here);
  const worktrees = parseWorktrees(sh("git", ["worktree", "list", "--porcelain"]).stdout);
  const base = `origin/${(await loadProject()).gate.base}`;
  for (const { number, title, branch } of split.here) {
    const { comments } = claimed.find((each) => each.number === number)!;
    const state = ticketState(
      { number, branch, comments },
      { worktrees, prs: open, runDir: run.dir, base },
      sh,
    );
    console.log(`${number}\t${title}\t${branch}\t${nextStep(state)}`);
  }
  for (const line of split.stale) console.error(`stale: ${line}`);
  for (const line of split.elsewhere) console.error(`elsewhere or orphaned: ${line}`);
  return 0;
}

/** `factory park <n> [--reason <text>] [--run-dir <path>]`: parks a ticket for a decision, keeping all its work. */
export async function park(args: string[], sh: Exec = exec): Promise<number> {
  const run = runDir(args, sh);
  const rest = run?.rest ?? [];
  const at = rest.indexOf("--reason");
  const reason =
    at > 0 ? rest.slice(at + 1).join(" ") : "waiting on a decision; see the comments above";
  const number = Number(rest[0]);
  if (
    !run ||
    !Number.isInteger(number) ||
    number <= 0 ||
    reason === "" ||
    (at < 0 && rest.length > 1)
  ) {
    console.log("usage: factory park <n> [--reason <text>] [--run-dir <path>]");
    return 2;
  }
  mkdirSync(run.dir, { recursive: true });
  const parked = parkTicket(
    { number, reason, runDir: run.dir, repo: repoName(sh), machine: who(sh) },
    sh,
    (file, text) => writeFileSync(file, text),
  );
  for (const line of parked.said) console.log(line);
  if (!parked.comment) return 1;
  gh(giveBack(number), sh);
  console.log(`gave the claim back: #${number} is decision needed`);
  console.log(gh(["issue", "comment", String(number), "--body-file", "-"], sh, parked.comment));
  return parked.ok ? 0 : 1;
}

const SHOT = /\.(png|jpe?g|gif|webp|webm|mp4|mov)$/i;

function shotsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => SHOT.test(file))
    .sort()
    .map((file) => join(dir, file));
}

/** `factory push <n> --auto-merge on|off [--shots <dir>] [--title <text>]`, in the ticket's worktree. */
export async function push(args: string[], sh: Exec = exec): Promise<number> {
  const pushing = parseArgs(args);
  if (!pushing) {
    console.log(PUSH_USAGE);
    return 2;
  }
  const resolved = await loadProject();
  const bodyFile = sh("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    PR_BODY,
  ]).stdout.trim();
  try {
    const ok = pushBranch(pushing, {
      sh,
      base: `origin/${resolved.gate.base}`,
      migrations: resolved.foreman.migrations,
      method: resolved.merge.method,
      bodyFile,
      read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
      shotsIn,
      log: (line) => console.log(line),
    });
    return ok ? 0 : 1;
  } catch (error) {
    console.log(`factory push: stopped: ${(error as Error).message}`);
    return 1;
  }
}

/** `factory inspectors [<base>]`: the axes quality control inspects this branch on, one `<axis>\t<agent>\t<why>` a line. */
export async function inspectors(args: string[], sh: Exec = exec): Promise<number> {
  if (args.length > 1) {
    console.log("usage: factory inspectors [<base>]");
    return 2;
  }
  const resolved = await loadProject();
  const base = args[0] ?? `origin/${resolved.gate.base}`;
  const fork = sh("git", ["merge-base", base, "HEAD"]);
  const diff = fork.status === 0 && sh("git", ["diff", "--name-only", fork.stdout.trim(), "HEAD"]);
  if (!diff || diff.status !== 0) {
    console.log(`git can't read ${base}...HEAD`);
    return 1;
  }
  const files = diff.stdout.split("\n").filter(Boolean);
  for (const { axis, why } of axesFor(files, resolved))
    console.log(`${axis}\t${INSPECTORS[axis]}\t${why}`);
  return 0;
}
