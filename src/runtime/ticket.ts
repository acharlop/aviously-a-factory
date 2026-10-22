/** What GitHub, git and the run folder show of one claimed ticket: everything a step reads to tell whether its output is there. */
export type TicketState = {
  number: number;
  branch: string;
  /** The branch's head commit, or "" when the branch isn't here. */
  head: string;
  /** Commits on the branch past its merge-base with the base branch. */
  ahead: number;
  /** Whether the temp wrote the PR body file in the worktree's git dir. */
  bodyFile: boolean;
  comments: { body: string }[];
  /** Quality control's report on the head, from the run folder, when there is one. */
  report?: { findings: number };
  pr?: { url: string; autoMerge: boolean };
};

type Comment = { body: string; createdAt?: string; url?: string };

const CLAIM = /In progress on branch `?([\w./-]+)`?(?: on `?([\w.-]+))?/;

/** The comment that claims a ticket. The machine tells claims apart, since a person's machines share one gh login. */
export const claimComment = (branch: string, machine: string) =>
  `In progress on branch \`${branch}\` on ${machine}`;

/** Every claim comment, oldest first, with the branch and machine it names. */
export const claims = (comments: readonly Comment[]) =>
  comments.flatMap((comment) => {
    const [, branch, host] = CLAIM.exec(comment.body) ?? [];
    return branch ? [{ ...comment, branch, host, at: comment.createdAt ?? "" }] : [];
  });

/** The latest claim comment, with the branch it names and the machine it was made on. */
export const latestClaim = (comments: readonly Comment[]) => claims(comments).at(-1);

/** The branch the latest claim comment names. */
export const claimedBranch = (comments: readonly Comment[]) => latestClaim(comments)?.branch;

/** The comment that records a branch's head passed quality control and rework. */
export const reviewedComment = (sha: string) => `Reviewed at \`${sha}\``;

/** Whether a "Reviewed at" comment already names sha. */
export const reviewedAt = (comments: readonly { body: string }[], sha: string) =>
  sha !== "" &&
  comments.some(({ body }) =>
    [...body.matchAll(/Reviewed at `([0-9a-f]{7,40})`/g)].some(([, at]) => sha.startsWith(at!)),
  );
