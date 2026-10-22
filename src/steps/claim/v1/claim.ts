import type { Exec } from "../../../runtime/exec.ts";
import { gh, ghJson } from "../../../runtime/github.ts";
import { claimComment, claims, latestClaim } from "../../../runtime/ticket.ts";
import { mentions, type OpenPr } from "./free.ts";
import { IN_PROGRESS } from "./step.ts";

type Comment = { body: string; createdAt?: string; url?: string };

export type Claimed = { number: number; title: string; comments: Comment[] };
export type MergedPr = OpenPr & { url: string; mergedAt: string };

/** Claims split into those whose branch is a local branch here (worktrees share refs), stale ones (no open PR, one merged since the claim) and the rest. */
export function inFlight(
  claimed: readonly Claimed[],
  openPrs: readonly OpenPr[],
  merged: readonly MergedPr[],
  branchHere: (branch: string) => boolean,
) {
  const here: { number: number; title: string; branch: string }[] = [];
  const stale: string[] = [];
  const elsewhere: string[] = [];
  for (const { number, title, comments } of [...claimed].sort((a, b) => a.number - b.number)) {
    const claim = latestClaim(comments);
    const line = `${number}\t${title}\t${claim?.branch ?? "?"}`;
    const landed =
      !openPrs.some((pr) => mentions(pr, number)) &&
      merged.find((pr) => mentions(pr, number) && pr.mergedAt > (claim?.at ?? ""));
    if (claim && branchHere(claim.branch)) here.push({ number, title, branch: claim.branch });
    else if (landed) stale.push(`${line}\tmerged ${landed.url}`);
    else elsewhere.push(`${line}\ton ${claim?.host ?? "?"}`);
  }
  return { here, stale, elsewhere };
}

type Ticket = { state: string; assignees: { login: string }[]; labels: { name: string }[] };

/** Why the ticket can't be claimed now, or undefined when it can. */
export function notFree(ticket: Ticket): string | undefined {
  if (ticket.state !== "OPEN") return "it is closed";
  if (ticket.labels.some(({ name }) => name === IN_PROGRESS)) return `it is ${IN_PROGRESS}`;
  if (ticket.assignees.length > 0)
    return `it is assigned to ${ticket.assignees.map(({ login }) => login).join(", ")}`;
  return undefined;
}

/** How far back of this claim another counts as racing it: GitHub's clock and this machine's may differ. */
const RACE_MS = 5 * 60_000;

/** The claim that won a race: the earliest made since `since`, or undefined when there is none. */
export function winner(comments: readonly Comment[], since: number) {
  return claims(comments).find(({ at }) => Date.parse(at) >= since - RACE_MS);
}

/**
 * Claims the ticket for `branch` on `machine`: assignee, `in-progress`, the claim comment. When
 * another claim raced it and was earlier, takes back its own comment and says who holds it.
 */
export function claim(
  {
    number,
    branch,
    machine,
    repo,
  }: { number: number; branch: string; machine: string; repo: string },
  sh: Exec,
  now = Date.now(),
): { ok: boolean; said: string } {
  const n = String(number);
  const ticket = ghJson<Ticket>(["issue", "view", n, "--json", "state,assignees,labels"], sh);
  const why = notFree(ticket);
  if (why) return { ok: false, said: `#${number} isn't free: ${why}` };
  gh(["issue", "edit", n, "--add-assignee", "@me", "--add-label", IN_PROGRESS], sh);
  gh(["issue", "comment", n, "--body", claimComment(branch, machine)], sh);
  const { comments } = ghJson<{ comments: Comment[] }>(
    ["issue", "view", n, "--json", "comments"],
    sh,
  );
  const won = winner(comments, now);
  if (!won || (won.branch === branch && won.host === machine))
    return { ok: true, said: `claimed #${number} for ${branch} on ${machine}` };
  const own = claims(comments).findLast((c) => c.branch === branch && c.host === machine);
  const id = /issuecomment-(\d+)/.exec(own?.url ?? "")?.[1];
  if (id) gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`], sh);
  return {
    ok: false,
    said: `#${number} was claimed first for ${won.branch} on ${won.host ?? "?"}; took back this claim`,
  };
}
