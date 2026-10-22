import { basename, matchesGlob } from "node:path";

import type { Exec } from "../../../runtime/exec.ts";
import { gh, ghJson } from "../../../runtime/github.ts";
import { claimedBranch, reviewedAt, reviewedComment } from "../../../runtime/ticket.ts";
import { workingBranch } from "../../../runtime/worktrees.ts";

export type Pushing = { number: number; autoMerge: boolean; shots?: string; title?: string };

export type Deps = {
  sh: Exec;
  /** Globs of schema files whose change needs its migration generated before the push. */
  migrations: readonly string[];
  /** The PR body file's path, from the worktree's git dir. */
  bodyFile: string;
  /** The file's text, or undefined when it doesn't exist. */
  read: (file: string) => string | undefined;
  /** The image and video files under a folder. */
  shotsIn: (dir: string) => string[];
  log: (line: string) => void;
};

type Issue = {
  assignees: { login: string }[];
  labels: { name: string }[];
  comments: { body: string }[];
};

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

/** The PR's title and body from the body file, its `# ` first line the title unless one is given; or why they're missing. */
export function prText(bodyFile: string, file = "", title?: string) {
  const [first = "", ...rest] = file.trim().split("\n");
  const heading = /^#\s+(.+)$/.exec(first.trim())?.[1]?.trim();
  const body = (heading ? rest.join("\n") : file).trim();
  if (!body) return `no PR body in ${bodyFile}: the temp writes it`;
  const subject = title ?? heading;
  if (!subject)
    return `no \`# <title>\` first line in ${bodyFile}, and no --title: the PR's title is the squash commit's`;
  return { title: subject, body };
}

/** Why the claim on the ticket no longer holds for branch, or undefined while it does. */
export function claimLost(issue: Issue, login: string, branch: string, otherPrs: string[]) {
  if (!issue.assignees.some((assignee) => assignee.login === login))
    return `${login} is no longer assigned`;
  if (!issue.labels.some((label) => label.name === "in-progress")) return "it isn't in-progress";
  const claimed = claimedBranch(issue.comments);
  if (claimed !== branch) return `the latest claim names ${claimed ?? "no branch"}`;
  if (otherPrs.length > 0) return `another PR is open for it: ${otherPrs.join(", ")}`;
  return undefined;
}

/**
 * Pushes the ticket's branch and opens or updates its ready PR; false, said, at the first step
 * that fails. The push runs the project's pre-push hook, which is the gate before the queue's.
 */
export function push({ number, autoMerge, shots, title }: Pushing, deps: Deps): boolean {
  const { sh, log } = deps;
  const stop = (why: string) => (log(`factory push: stopped: ${why}`), false);
  const git = (...args: string[]) => sh("git", args);
  const read = (...args: string[]) => git(...args).stdout.trim();

  const branch = read("rev-parse", "--abbrev-ref", "HEAD");
  if (workingBranch([branch], number) !== branch)
    return stop(
      `${branch} isn't a <department>/${number}-<slug> branch: run it in the ticket's worktree`,
    );
  const written = prText(deps.bodyFile, deps.read(deps.bodyFile), title);
  if (typeof written === "string") return stop(written);
  // The folder also holds other tickets' shots; only this ticket's are the branch's.
  const attach =
    shots === undefined
      ? []
      : deps
          .shotsIn(shots)
          .filter((file) => basename(file).startsWith(`${number}-`))
          .flatMap((file) => ["--attach", file]);
  if (shots !== undefined && attach.length === 0)
    return stop(`no screenshots named ${number}-* in ${shots}`);

  const issue = ghJson<Issue>(
    ["issue", "view", String(number), "--json", "assignees,labels,comments"],
    sh,
  );
  const prs = ghJson<{ url: string; headRefName: string }[]>(
    ["pr", "list", "--state", "open", "--search", String(number), "--json", "url,headRefName"],
    sh,
  );
  const lost = claimLost(
    issue,
    gh(["api", "user", "--jq", ".login"], sh),
    branch,
    // The search is full text, so a PR whose body only names the ticket comes back too.
    prs
      .filter((pr) => pr.headRefName !== branch && pr.headRefName.includes(`/${number}-`))
      .map((pr) => pr.url),
  );
  if (lost) return stop(`the claim is lost (${lost}): the foreman parks it`);
  const own = prs.find((pr) => pr.headRefName === branch)?.url;

  const base = read("merge-base", "HEAD", "origin/main");
  const schema = read("diff", "--name-only", base, "HEAD")
    .split("\n")
    .filter((file) => file && deps.migrations.some((glob) => matchesGlob(file, glob)));
  if (schema.length > 0)
    return stop(
      `the schema changed (${schema.join(", ")}): merge origin/main and generate the migration first`,
    );
  if (read("status", "--porcelain") !== "") return stop("the working tree isn't clean");

  const head = read("rev-parse", "HEAD");
  const pushed = git("push", "-u", "origin", branch);
  if (pushed.status !== 0) return stop(`git push: ${lastLine(pushed.stderr)}`);

  const text = ["--title", written.title, "--body-file", "-", ...attach];
  let url = own;
  if (url) {
    gh(["pr", "edit", url, ...text], sh, written.body);
    log(`updated the title and body of ${url}`);
  } else url = lastLine(gh(["pr", "create", "--head", branch, ...text], sh, written.body));
  if (autoMerge) gh(["pr", "merge", url, "--auto", "--squash", "--delete-branch"], sh);
  if (!reviewedAt(issue.comments, head))
    gh(["issue", "comment", String(number), "--body", reviewedComment(head)], sh);
  log(`PR: ${url}`);
  log(`auto-merge: ${autoMerge ? "on" : "off"}`);
  return true;
}

export const USAGE = "usage: factory push <n> --auto-merge on|off [--shots <dir>] [--title <text>]";

/** The pushing the arguments ask for, or undefined when they don't parse. */
export function parseArgs(args: readonly string[]): Pushing | undefined {
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const [flag, value] = [args[i]!, args[i + 1]];
    if (!["--auto-merge", "--shots", "--title"].includes(flag) || !value) return undefined;
    flags.set(flag, value);
  }
  const number = Number(args[0]);
  const autoMerge = flags.get("--auto-merge");
  if (!Number.isInteger(number) || number <= 0 || (autoMerge !== "on" && autoMerge !== "off"))
    return undefined;
  return {
    number,
    autoMerge: autoMerge === "on",
    ...(flags.has("--shots") && { shots: flags.get("--shots") }),
    ...(flags.has("--title") && { title: flags.get("--title") }),
  };
}
