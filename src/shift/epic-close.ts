import type { Exec } from "../runtime/exec.ts";
import { gh, graphql, repoName } from "../runtime/github.ts";

type Link = { number: number; url: string };

export type Closed = Link & {
  state: string;
  closer: Link | undefined;
  epic:
    | (Link & { state: string; subIssues: { state: string }[]; comments: { body: string }[] })
    | undefined;
};

const CLAIM_LABELS = new Set(["in-progress", "ready-for-agent"]);

/** The `gh issue edit` arguments that take a closed ticket's claim and route off it, or none when nothing is left on it. */
export function claimLeft(ticket: {
  state: string;
  labels: readonly string[];
  assignees: readonly string[];
}): string[] {
  if (ticket.state !== "CLOSED") return [];
  return [
    ...ticket.labels
      .filter((label) => CLAIM_LABELS.has(label))
      .flatMap((label) => ["--remove-label", label]),
    ...ticket.assignees.flatMap((login) => ["--remove-assignee", login]),
  ];
}

export type EpicStep = { comment?: string; close?: string; said: string[] };

/** What the epic needs after the ticket closed: a landed comment unless one names it already, and a close when no sub-issue is open. */
export function epicStep(ticket: Closed): EpicStep {
  const { epic } = ticket;
  if (ticket.state !== "CLOSED") return { said: [`#${ticket.number} isn't closed yet`] };
  if (!epic) return { said: [`#${ticket.number} has no parent epic`] };
  const step: EpicStep = { said: [] };
  const landed = `Landed: [#${ticket.number} 📋](${ticket.url})`;
  if (epic.comments.some(({ body }) => body.startsWith(landed)))
    step.said.push(`epic #${epic.number} already says #${ticket.number} landed`);
  else {
    const by = ticket.closer
      ? `, by [#${ticket.closer.number} 🔀](${ticket.closer.url})`
      : ", closed without a pull request";
    step.comment = `${landed}${by}.`;
    step.said.push(`commented on epic #${epic.number} that #${ticket.number} landed`);
  }
  if (epic.state !== "OPEN") return step;
  const open = epic.subIssues.filter(({ state }) => state === "OPEN").length;
  if (open > 0) step.said.push(`epic #${epic.number} has ${open} open sub-issues; left open`);
  else {
    step.close = "Every sub-issue is closed.";
    step.said.push(`closed epic #${epic.number}: its last sub-issue closed`);
  }
  return step;
}

const QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $n) {
      number url state
      labels(first: 30) { nodes { name } }
      assignees(first: 10) { nodes { login } }
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
        nodes { ... on ClosedEvent { closer { ... on PullRequest { number url } } } }
      }
      parent {
        number url state
        subIssues(first: 100) { nodes { state } }
        comments(last: 100) { nodes { body } }
      }
    }
  }
}`;

type Raw = {
  repository: {
    issue: Link & {
      state: string;
      labels: { nodes: { name: string }[] };
      assignees: { nodes: { login: string }[] };
      timelineItems: { nodes: { closer: Partial<Link> | null }[] };
      parent:
        | (Link & {
            state: string;
            subIssues: { nodes: { state: string }[] };
            comments: { nodes: { body: string }[] };
          })
        | null;
    };
  };
};

/** `factory epic-close <ticket>`, once a ticket closes: drops its claim, route and assignees, says on its epic what landed, and closes the epic once every sub-issue is closed. */
export function epicClose(args: readonly string[], sh: Exec): number {
  const number = Number(args[0]);
  if (args.length !== 1 || !Number.isInteger(number) || number <= 0) {
    console.log("usage: factory epic-close <ticket>");
    return 2;
  }
  const [owner = "", name = ""] = repoName(sh).split("/");
  const { issue } = graphql<Raw>(QUERY, { owner, name, n: number }, sh).repository;
  const cleanup = claimLeft({
    state: issue.state,
    labels: issue.labels.nodes.map(({ name }) => name),
    assignees: issue.assignees.nodes.map(({ login }) => login),
  });
  if (cleanup.length > 0) {
    gh(["issue", "edit", String(number), ...cleanup], sh);
    console.log(`epic-close: #${number} ${cleanup.join(" ")}`);
  }
  const closer = issue.timelineItems.nodes[0]?.closer;
  const { parent } = issue;
  const step = epicStep({
    ...issue,
    closer: closer?.number && closer.url ? { number: closer.number, url: closer.url } : undefined,
    epic: parent
      ? { ...parent, subIssues: parent.subIssues.nodes, comments: parent.comments.nodes }
      : undefined,
  });
  const epic = String(parent?.number);
  if (step.comment) gh(["issue", "comment", epic, "--body", step.comment], sh);
  if (step.close) gh(["issue", "close", epic, "--comment", step.close], sh);
  for (const line of step.said) console.log(`epic-close: ${line}`);
  return issue.state === "CLOSED" ? 0 : 1;
}
