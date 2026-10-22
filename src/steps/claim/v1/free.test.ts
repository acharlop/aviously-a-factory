import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Candidate,
  type Filter,
  freeTickets,
  kindOf,
  mentions,
  namedOnMain,
  type OpenPr,
  type Order,
  orderLine,
  recordsDecision,
} from "./free.ts";

const issue = (
  number: number,
  createdAt: string,
  overrides: Partial<Candidate> = {},
): Candidate => ({
  number,
  title: `Ticket ${number}`,
  createdAt,
  labels: { nodes: [{ name: "ready-for-agent" }] },
  assignees: { totalCount: 0 },
  blockedBy: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [] },
  comments: { nodes: [] },
  ...overrides,
});
const labels = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });
const ready = (number: number, at: string, ...extra: string[]) =>
  issue(number, at, { labels: labels("ready-for-agent", ...extra) });
const openPr = (overrides: Partial<OpenPr>): OpenPr => ({
  number: 900,
  title: "Orders: something",
  body: "",
  headRefName: "web/899-something",
  ...overrides,
});
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T00:00:00Z`;
const all: Filter = { departments: [], kinds: [] };

const free = (
  tickets: readonly Candidate[],
  order: Order = "priority",
  { filter = all, shift = 1, device }: { filter?: Filter; shift?: number; device?: string } = {},
  prs: OpenPr[] = [],
  onMain = new Set<number>(),
) =>
  freeTickets(tickets, prs, onMain, { filter, order, shift, ...(device && { device }) }).map(
    ({ number }) => number,
  );

test("priority takes p1, normal, p3, then features, bugs, debt, security, tooling, oldest first", () => {
  const tickets = [
    ready(1, day(1), "kind:tooling"),
    ready(2, day(2), "kind:security"),
    ready(3, day(3), "kind:bug"),
    ready(4, day(4)),
    ready(5, day(5), "kind:feature"),
    ready(6, day(6), "kind:debt"),
    ready(7, day(7), "kind:tooling", "p1"),
    ready(8, day(8), "kind:feature", "p3"),
  ];
  assert.deepEqual(free(tickets), [7, 4, 5, 3, 6, 2, 1, 8]);
  assert.equal(
    orderLine("priority", 2),
    "# order: priority: p1, normal, p3; then feature, bug, debt, security, tooling; oldest first",
  );
});

test("alternate ranks as priority does, oldest first on odd shifts and newest first on even ones", () => {
  const tickets = [ready(1, day(1), "p3"), ready(2, day(2)), ready(3, day(3)), ready(4, day(4))];
  assert.deepEqual(free(tickets, "alternate", { shift: 1 }), [2, 3, 4, 1]);
  assert.deepEqual(free(tickets, "alternate", { shift: 2 }), [4, 3, 2, 1]);
  assert.match(orderLine("alternate", 0), /; newest first$/);
});

test("fifo and lifo go by age alone, whatever the priority or kind", () => {
  const tickets = [
    ready(2, day(2), "p3"),
    ready(1, day(1), "kind:tooling"),
    ready(3, day(3), "p1"),
  ];
  assert.deepEqual(free(tickets, "fifo"), [1, 2, 3]);
  assert.deepEqual(free(tickets, "lifo"), [3, 2, 1]);
  assert.equal(orderLine("lifo", 1), "# order: lifo, newest first");
});

test("a ticket that's assigned, in progress, blocked by an open ticket, has an open PR or is on main isn't free", () => {
  const at = day(1);
  const tickets = [
    issue(1, at),
    issue(2, at, { assignees: { totalCount: 1 } }),
    ready(3, at, "in-progress"),
    issue(4, at, { blockedBy: { nodes: [{ state: "OPEN" }] } }),
    issue(5, at, { blockedBy: { nodes: [{ state: "CLOSED" }] } }),
    issue(6, at, { closedByPullRequestsReferences: { nodes: [{ state: "OPEN" }] } }),
    issue(7, at),
    issue(8, at),
    issue(9, at, { labels: labels("decision needed") }),
  ];
  const prs = [openPr({ body: "Fixes [#7 📋](https://github.com/o/app/issues/7)" })];
  assert.deepEqual(free(tickets, "fifo", {}, prs, new Set([8])), [1, 5]);
});

test("the filter admits tickets of any department and any kind it names", () => {
  const at = day(1);
  const tickets = [
    ready(1, at, "department:web", "kind:feature"),
    ready(2, at, "department:api", "kind:bug"),
    ready(3, at, "department:web", "kind:bug"),
    ready(4, at, "kind:feature"),
  ];
  assert.deepEqual(free(tickets, "fifo", { filter: { departments: ["web"], kinds: [] } }), [1, 3]);
  assert.deepEqual(free(tickets, "fifo", { filter: { departments: [], kinds: ["bug"] } }), [2, 3]);
  assert.deepEqual(
    free(tickets, "fifo", { filter: { departments: ["web", "api"], kinds: ["bug"] } }),
    [2, 3],
  );
});

test("the device department waits for a shift that names it, and its odd jobs ticket is never free", () => {
  const at = day(1);
  const tickets = [
    ready(1, at, "department:mobile"),
    ready(2, at),
    ready(3, at, "department:mobile", "odd jobs"),
    ready(4, at, "odd jobs"),
  ];
  assert.deepEqual(free(tickets, "fifo", { device: "mobile" }), [2, 4]);
  const mobile = { departments: ["mobile"], kinds: [] };
  assert.deepEqual(free(tickets, "fifo", { filter: mobile, device: "mobile" }), [1]);
  assert.deepEqual(free(tickets, "fifo"), [1, 2, 3, 4]);
});

test("a Decide: ticket waits for its Decided: comment", () => {
  const at = day(1);
  const comments = (...bodies: string[]) => ({ nodes: bodies.map((body) => ({ body })) });
  const tickets = [
    issue(2, at, { title: "Decide: route colours" }),
    issue(3, at, {
      title: "Decide: route colours",
      comments: comments("Options?", "Decided: blue"),
    }),
    issue(5, at, { title: "Orders: Decide: later", comments: comments("not decided") }),
    issue(6, at, { title: "Decide: names", comments: comments("**Decided:** strict") }),
  ];
  assert.deepEqual(free(tickets, "fifo"), [3, 5, 6]);
});

test("a decision counts plain, bold or italic, and only at the start of a line or after a list, quote or heading marker", () => {
  for (const said of [
    "Decided: blue",
    "Options above.\n\n**Decided:** blue",
    "__Decided:__ blue",
    "*Decided*: blue",
    "- **Decided:** blue",
    "1. Decided: blue",
    "> Decided: blue",
    "## Decided: blue",
  ])
    assert.ok(recordsDecision(said), said);
  for (const said of ["Not **Decided:** yet", "- Not Decided: yet", "Undecided: blue"])
    assert.ok(!recordsDecision(said), said);
});

test("an open PR names a ticket by #n, its URL or its branch, never by a longer number", () => {
  assert.ok(mentions(openPr({ title: "Orders: fix (#42)" }), 42));
  assert.ok(mentions(openPr({ body: "Refs https://github.com/o/app/issues/42" }), 42));
  assert.ok(mentions(openPr({ headRefName: "web/42-pending-status" }), 42));
  assert.ok(!mentions(openPr({ body: "Fixes #421", headRefName: "web/421-x" }), 42));
});

test("main counts a ticket its commits close, never one a body only mentions or builds part of", () => {
  const log = [
    "Orders: pending reads Open (#570)",
    "Fixes [#569 📋](https://github.com/o/app/issues/569)",
    "closes #571, Resolves: https://github.com/o/app/issues/572",
    "Part of [#573 📋](https://github.com/o/app/issues/573)",
    "- [#842 📋](https://github.com/o/app/issues/842) log the sent, related #599, fixes #5990",
  ].join("\n");
  assert.deepEqual([...namedOnMain(log)].sort(), [569, 571, 572, 5990]);
});

test("a ticket's kind is its kind: label", () => {
  assert.equal(kindOf(ready(1, day(1), "kind:security")), "security");
  assert.equal(kindOf(ready(1, day(1))), undefined);
});
