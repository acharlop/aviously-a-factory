import assert from "node:assert/strict";
import { test } from "node:test";

import type { Exec } from "../../../runtime/exec.ts";
import { claimComment, claimedBranch, latestClaim } from "../../../runtime/ticket.ts";
import { claim, type Claimed, inFlight } from "./claim.ts";

test("the branch comes from the latest claim comment, quoted or not", () => {
  assert.equal(
    claimedBranch([
      { body: "In progress on branch web/12-old" },
      { body: "Reviewed at `abc123`" },
      { body: "In progress on branch `tooling/572-round-2` (runner: elsewhere)" },
    ]),
    "tooling/572-round-2",
  );
  assert.equal(claimedBranch([{ body: "Looks good" }]), undefined);
  assert.equal(latestClaim([{ body: claimComment("a/1-b", "studio") }])?.host, "studio");
});

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 10, minutes)).toISOString();
const claimOf = (number: number, body: string, createdAt = at(0)): Claimed => ({
  number,
  title: `Ticket ${number}`,
  comments: [{ body, createdAt }],
});
const pr = (number: number, body: string, mergedAt = "") => ({
  number,
  title: "Tooling: a change",
  body,
  headRefName: `tooling/${number}-change`,
  url: `https://github.com/o/app/pull/${number}`,
  mergedAt,
});

test("a claim is in flight here only when its branch is a local branch; the rest name the machine that claimed them", () => {
  const here = (branch: string) => branch === "web/7-here";
  assert.deepEqual(
    inFlight(
      [
        claimOf(9, claimComment("web/9-other", "office")),
        claimOf(7, claimComment("web/7-here", "studio")),
        claimOf(8, "Looks good"),
      ],
      [],
      [],
      here,
    ),
    {
      here: [{ number: 7, title: "Ticket 7", branch: "web/7-here" }],
      stale: [],
      elsewhere: ["8\tTicket 8\t?\ton ?", "9\tTicket 9\tweb/9-other\ton office"],
    },
  );
});

test("a claim whose ticket a PR merged after the claim, with none open, is stale; an open PR or a later claim keeps it elsewhere", () => {
  const merged = "2026-10-12T00:00:00Z";
  const claimed = (n: number, createdAt?: string) =>
    claimOf(n, claimComment(`tooling/${n}-odd-jobs`, "studio"), createdAt);
  assert.deepEqual(
    inFlight(
      [claimed(874), claimed(875), claimed(876, "2026-10-13T00:00:00Z")],
      [pr(1002, "Fixes #875")],
      [
        pr(1001, "Part of #874", merged),
        pr(1003, "Fixes #875", merged),
        pr(1004, "Fixes #876", merged),
      ],
      () => false,
    ),
    {
      here: [],
      stale: ["874\tTicket 874\ttooling/874-odd-jobs\tmerged https://github.com/o/app/pull/1001"],
      elsewhere: [
        "875\tTicket 875\ttooling/875-odd-jobs\ton studio",
        "876\tTicket 876\ttooling/876-odd-jobs\ton studio",
      ],
    },
  );
});

/** gh in memory: the ticket's state, and the comments it has once this claim lands. */
function fakeGh(ticket: object, comments: object[]) {
  const calls: string[] = [];
  const sh: Exec = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const json = args.at(-1);
    const stdout =
      args[1] === "view" ? JSON.stringify(json === "comments" ? { comments } : ticket) : "";
    return { status: 0, stdout, stderr: "" };
  };
  return { sh, calls };
}

const freeTicket = { state: "OPEN", assignees: [], labels: [{ name: "ready-for-agent" }] };
const claiming = { number: 7, branch: "web/7-a", machine: "studio", repo: "o/app" };
const now = Date.parse(at(10));

test("a free ticket is claimed: assignee, in-progress, then the comment naming branch and machine", () => {
  const { sh, calls } = fakeGh(freeTicket, [
    { body: claimComment("web/7-old", "studio"), createdAt: at(-90) },
    { body: claimComment("web/7-a", "studio"), createdAt: at(10) },
  ]);
  assert.deepEqual(claim(claiming, sh, now), {
    ok: true,
    said: "claimed #7 for web/7-a on studio",
  });
  assert.deepEqual(calls.slice(1, 3), [
    "gh issue edit 7 --add-assignee @me --add-label in-progress",
    "gh issue comment 7 --body In progress on branch `web/7-a` on studio",
  ]);
});

test("a ticket someone holds is never claimed", () => {
  for (const [ticket, why] of [
    [{ ...freeTicket, assignees: [{ login: "avi" }] }, /assigned to avi/],
    [{ ...freeTicket, labels: [{ name: "in-progress" }] }, /it is in-progress/],
    [{ ...freeTicket, state: "CLOSED" }, /it is closed/],
  ] as const) {
    const { sh, calls } = fakeGh(ticket, []);
    const claimed = claim(claiming, sh, now);
    assert.equal(claimed.ok, false);
    assert.match(claimed.said, why);
    assert.equal(calls.length, 1);
  }
});

test("when another machine's claim landed first, this one takes its comment back and leaves the claim to it", () => {
  const { sh, calls } = fakeGh(freeTicket, [
    { body: claimComment("web/7-b", "office"), createdAt: at(9) },
    {
      body: claimComment("web/7-a", "studio"),
      createdAt: at(10),
      url: "https://github.com/o/app/issues/7#issuecomment-555",
    },
  ]);
  assert.deepEqual(claim(claiming, sh, now), {
    ok: false,
    said: "#7 was claimed first for web/7-b on office; took back this claim",
  });
  assert.equal(calls.at(-1), "gh api -X DELETE repos/o/app/issues/comments/555");
});
