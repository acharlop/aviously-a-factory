import { IN_PROGRESS } from "./step.ts";

export type Candidate = {
  number: number;
  title: string;
  createdAt: string;
  labels: { nodes: { name: string }[] };
  assignees: { totalCount: number };
  blockedBy: { nodes: { state: string }[] };
  closedByPullRequestsReferences: { nodes: { state: string }[] };
  comments: { nodes: { body: string }[] };
};

export const CANDIDATE_FIELDS = `number title createdAt
  labels(first: 30) { nodes { name } }
  assignees { totalCount }
  blockedBy(first: 30) { nodes { state } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { state } }
  comments(last: 50) { nodes { body } }`;

export type OpenPr = { number: number; title: string; body: string; headRefName: string };

export const ORDERS = ["priority", "fifo", "lifo", "alternate"] as const;
export type Order = (typeof ORDERS)[number];

/** What a shift admits: tickets of any of `departments` and any of `kinds`, either list empty for all. */
export type Filter = { departments: string[]; kinds: string[] };

/** The kinds in the order a priority shift takes them; a ticket with no kind ranks as a feature. */
export const KINDS = ["feature", "bug", "debt", "security", "tooling"] as const;

const labelled = (issue: Candidate, name: string) =>
  issue.labels.nodes.some((label) => label.name === name);

/** A ticket's kind, from its `kind:` label, or undefined when it has none. */
export const kindOf = (issue: Candidate) =>
  issue.labels.nodes.find(({ name }) => name.startsWith("kind:"))?.name.slice("kind:".length);

const kindRank = (issue: Candidate) => {
  const at = KINDS.indexOf((kindOf(issue) ?? "feature") as (typeof KINDS)[number]);
  return at < 0 ? KINDS.length : at;
};

/** `p1` first, normal next, `p3` last. */
const priorityOf = (issue: Candidate) =>
  labelled(issue, "p1") ? 0 : labelled(issue, "p3") ? 2 : 1;

/** Which way a shift reads ages: `alternate` takes the oldest first on odd shifts and the newest on even ones. */
const oldestFirst = (order: Order, shift: number) =>
  order === "fifo" || order === "priority" || (order === "alternate" && shift % 2 === 1);

/** The `# order:` line `factory free` prints first. */
export function orderLine(order: Order, shift: number): string {
  const age = oldestFirst(order, shift) ? "oldest first" : "newest first";
  if (order === "fifo" || order === "lifo") return `# order: ${order}, ${age}`;
  return `# order: ${order}: p1, normal, p3; then ${KINDS.join(", ")}; ${age}`;
}

/** Whether an open pull request names the ticket: `#n` or its URL in the title or body, or a `<department>/<n>-` branch. */
export function mentions(pr: OpenPr, number: number): boolean {
  const ref = new RegExp(`(#|/issues/)${number}(?!\\d)`);
  return ref.test(pr.title) || ref.test(pr.body) || pr.headRefName.includes(`/${number}-`);
}

/** The issue numbers main's commit messages close (`Closes`, `Fixes`, `Resolves`); a ticket a body only mentions or builds part of stays free, so an odd jobs ticket's unticked boxes decide what's left. */
export const namedOnMain = (log: string) =>
  new Set(
    [
      ...log.matchAll(
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+\[?(?:#|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)(\d+)(?!\d)/gi,
      ),
    ].map((found) => Number(found[1])),
  );

/** Whether a comment records the decision, as `Decided:` at a line start, bold or italic or plain, after any list, quote or heading marker. */
export const recordsDecision = (body: string) =>
  /^\s*(?:(?:[-+]|\d+[.)]|>|#{1,6})\s*)*Decided:/im.test(body.replace(/[*_]/g, ""));

/** Whether the ticket is in the shift's filter. A ticket of the device department is admitted only by a filter naming that department. */
function admitted(issue: Candidate, { departments, kinds }: Filter, device?: string): boolean {
  const departmentOf = (name: string) => labelled(issue, `department:${name}`);
  if (departments.length > 0 && !departments.some(departmentOf)) return false;
  if (device && departmentOf(device) && !departments.includes(device)) return false;
  return kinds.length === 0 || kinds.includes(kindOf(issue) ?? "");
}

/**
 * The free tickets the filter admits, in the order the shift takes them. `device` is the mobile
 * module's department; its odd jobs ticket is the device-check list a person works, never built.
 */
export function freeTickets(
  candidates: readonly Candidate[],
  openPrs: readonly OpenPr[],
  onMain: ReadonlySet<number>,
  {
    filter,
    order,
    shift,
    device,
  }: { filter: Filter; order: Order; shift: number; device?: string },
): Candidate[] {
  const free = candidates.filter(
    (issue) =>
      labelled(issue, "ready-for-agent") &&
      !labelled(issue, IN_PROGRESS) &&
      issue.assignees.totalCount === 0 &&
      issue.blockedBy.nodes.every(({ state }) => state !== "OPEN") &&
      issue.closedByPullRequestsReferences.nodes.every(({ state }) => state !== "OPEN") &&
      !openPrs.some((pr) => mentions(pr, issue.number)) &&
      !onMain.has(issue.number) &&
      admitted(issue, filter, device) &&
      !(device && labelled(issue, "odd jobs") && labelled(issue, `department:${device}`)) &&
      !(
        /^Decide:/i.test(issue.title) &&
        !issue.comments.nodes.some(({ body }) => recordsDecision(body))
      ),
  );
  const direction = oldestFirst(order, shift) ? 1 : -1;
  const ranked = order === "priority" || order === "alternate";
  return free.sort(
    (a, b) =>
      (ranked ? priorityOf(a) - priorityOf(b) || kindRank(a) - kindRank(b) : 0) ||
      direction * a.createdAt.localeCompare(b.createdAt),
  );
}
