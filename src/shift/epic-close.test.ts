import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { claimLeft, type Closed, epicClose, epicStep } from "./epic-close.ts";

const url = (kind: string, n: number) => `https://github.com/o/app/${kind}/${n}`;
const ticket = (overrides: Partial<Closed> = {}, subIssues = ["CLOSED", "OPEN"]): Closed => ({
  number: 12,
  url: url("issues", 12),
  state: "CLOSED",
  closer: { number: 30, url: url("pull", 30) },
  epic: {
    number: 5,
    url: url("issues", 5),
    state: "OPEN",
    subIssues: subIssues.map((state) => ({ state })),
    comments: [],
  },
  ...overrides,
});

test("a closed ticket's epic gets a comment naming the ticket and its PR, and stays open while a sub-issue is", () => {
  const step = epicStep(ticket());
  assert.equal(
    step.comment,
    "Landed: [#12 📋](https://github.com/o/app/issues/12), by [#30 🔀](https://github.com/o/app/pull/30).",
  );
  assert.equal(step.close, undefined);
  assert.match(step.said.join("\n"), /epic #5 has 1 open sub-issues; left open/);
});

test("the last sub-issue closing closes the epic", () => {
  const step = epicStep(ticket({}, ["CLOSED", "CLOSED"]));
  assert.ok(step.comment);
  assert.equal(step.close, "Every sub-issue is closed.");
});

test("a second run doesn't comment twice, and a ticket closed by hand says so", () => {
  const once = epicStep(ticket());
  const again = ticket();
  again.epic!.comments.push({ body: once.comment! });
  assert.equal(epicStep(again).comment, undefined);
  assert.match(
    epicStep(ticket({ closer: undefined })).comment!,
    /closed without a pull request\.$/,
  );
});

test("an open ticket, or one with no epic, changes nothing", () => {
  assert.deepEqual(epicStep(ticket({ state: "OPEN" })), { said: ["#12 isn't closed yet"] });
  assert.deepEqual(epicStep(ticket({ epic: undefined })), { said: ["#12 has no parent epic"] });
});

test("a closed ticket loses in-progress, ready-for-agent and its assignees; an open one keeps them", () => {
  const left = { labels: ["in-progress", "ready-for-agent", "kind:bug"], assignees: ["avi"] };
  assert.deepEqual(claimLeft({ state: "CLOSED", ...left }), [
    "--remove-label",
    "in-progress",
    "--remove-label",
    "ready-for-agent",
    "--remove-assignee",
    "avi",
  ]);
  assert.deepEqual(claimLeft({ state: "OPEN", ...left }), []);
});

test("the command takes the claim off, comments on the epic and closes it", () => {
  const calls: string[] = [];
  const issue = {
    number: 12,
    url: url("issues", 12),
    state: "CLOSED",
    labels: { nodes: [{ name: "in-progress" }] },
    assignees: { nodes: [{ login: "avi" }] },
    timelineItems: { nodes: [{ closer: { number: 30, url: url("pull", 30) } }] },
    parent: {
      number: 5,
      url: url("issues", 5),
      state: "OPEN",
      subIssues: { nodes: [{ state: "CLOSED" }] },
      comments: { nodes: [] },
    },
  };
  const sh: Exec = (_, args) => {
    calls.push(args.slice(0, 3).join(" "));
    const stdout =
      args[0] === "repo"
        ? JSON.stringify({ nameWithOwner: "o/app" })
        : args[1] === "graphql"
          ? JSON.stringify({ data: { repository: { issue } } })
          : "";
    return { status: 0, stdout, stderr: "" };
  };
  const log = mock.method(console, "log", () => {});
  try {
    assert.equal(epicClose(["12"], sh), 0);
    assert.equal(epicClose([], sh), 2);
  } finally {
    log.mock.restore();
  }
  assert.deepEqual(calls.slice(2), ["issue edit 12", "issue comment 5", "issue close 5"]);
});
