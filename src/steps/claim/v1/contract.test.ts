import assert from "node:assert/strict";
import { test } from "node:test";

import { FACTORY_LABELS } from "../../../labels.ts";
import { claimComment, claimedBranch, latestClaim } from "../../../runtime/ticket.ts";
import { type Candidate, freeTickets, ORDERS } from "./free.ts";
import { giveBack } from "./park.ts";
import { IN_PROGRESS } from "./step.ts";

const LABELS = FACTORY_LABELS.map(({ name }) => name);

test("claim@1 writes only factory labels: in-progress on a claim, decision needed when it gives one back", () => {
  assert.ok(LABELS.includes(IN_PROGRESS));
  for (const label of giveBack(1).filter((_, i, all) => /label$/.test(all[i - 1] ?? "")))
    assert.ok(LABELS.includes(label), label);
});

test("the claim comment claim@1 writes is the one later steps read back: its branch and its machine", () => {
  const comments = [{ body: "Looks good" }, { body: claimComment("web/7-a", "studio") }];
  assert.equal(claimedBranch(comments), "web/7-a");
  assert.equal(latestClaim(comments)?.host, "studio");
});

test("every order takes only ready-for-agent tickets nobody holds", () => {
  const ticket = (number: number, ...labels: string[]): Candidate => ({
    number,
    title: `T${number}`,
    createdAt: `2026-10-0${number}T00:00:00Z`,
    labels: { nodes: labels.map((name) => ({ name })) },
    assignees: { totalCount: 0 },
    blockedBy: { nodes: [] },
    closedByPullRequestsReferences: { nodes: [] },
    comments: { nodes: [] },
  });
  const tickets = [
    ticket(1, "ready-for-agent"),
    ticket(2, "ready-for-agent", IN_PROGRESS),
    ticket(3),
  ];
  for (const order of ORDERS)
    assert.deepEqual(
      freeTickets(tickets, [], new Set(), {
        filter: { departments: [], kinds: [] },
        order,
        shift: 1,
      }).map(({ number }) => number),
      [1],
      order,
    );
});
