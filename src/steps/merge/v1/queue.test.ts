import assert from "node:assert/strict";
import { test } from "node:test";

import { pr, queue, VERIFIED } from "./queue.fixture.ts";
import { runQueue } from "./queue.ts";

test("an empty queue runs nothing and says so", async () => {
  const { deps, ran, lines } = queue({ prs: [] });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, []);
  assert.deepEqual(lines, [
    "merge-queue: the queue is empty.",
    "merge-queue: Landed: none. Dropped: none.",
  ]);
});

test("one queued pull request runs each check it needs once, then is pushed and signed off as that same commit", async () => {
  const { deps, ran, lines, markers, records } = queue({ specs: { 1: ["zones.spec.ts"] } });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, [
    "merge #1 onto m",
    "verify s:m+1",
    "specs s:m+1 zones.spec.ts",
    "land s:m+1",
  ]);
  assert.equal(markers.get(VERIFIED), "s:m+1 m+1");
  assert.match(lines.join("\n"), /Landed: #1\. Dropped: none/);
  assert.deepEqual(
    records.map(({ check, outcome, sha, base, command }) => [check, outcome, sha, base, command]),
    [
      ["checks", "passed", "s:m+1", "m", "pnpm verify"],
      ["web", "passed", "s:m+1", "m", "e2e zones.spec.ts"],
    ],
  );
});

test("a check whose marker already names the test branch tip is skipped", async () => {
  const markers = new Map([[VERIFIED, "s:m+1"]]);
  const { deps, ran, lines } = queue({ markers });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, ["merge #1 onto m", "land s:m+1"]);
  assert.match(lines.join("\n"), /checks already passed on s:m\+1/);
  assert.equal(markers.get(VERIFIED), "s:m+1 m+1", "the record names the steps it covers");
});

test("several queued pull requests share one run of each check, then land in turn, each merged with the main the last one made", async () => {
  const { deps, ran, markers } = queue({ prs: [pr(1), pr(2)], specs: { 2: ["billing.spec.ts"] } });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, [
    "merge #1 onto m",
    "merge #2 onto m",
    "verify s:m+1+2",
    "specs s:m+1+2 billing.spec.ts",
    "land s:m+1",
    "merge #2 onto m+1",
    "land s:m+1+2",
  ]);
  assert.equal(markers.get(VERIFIED), "s:m+1+2 m+1 m+1+2");
});

test("the queue goes in the order auto-merge was turned on", async () => {
  const late = pr(1, { enabledAt: "2026-10-12T09:00:00Z" });
  const { deps, ran } = queue({ prs: [pr(2), late] });
  await runQueue(deps);
  assert.deepEqual(ran.slice(0, 2), ["merge #2 onto m", "merge #1 onto m"]);
});

test("a head whose code the test branch never ran, because main moved another way, waits for a new round instead of landing untested", async () => {
  const { deps, ran, lines } = queue({
    prs: [pr(1), pr(2)],
    specs: { 2: ["billing.spec.ts"] },
    mainMovesAfterLanding: true,
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran.slice(4), [
    "land s:m+1",
    "merge #2 onto m+1+99",
    "merge #2 onto m+1+99",
    "verify s:m+1+99+2",
    "specs s:m+1+99+2 billing.spec.ts",
    "land s:m+1+99+2",
  ]);
  assert.match(lines.join("\n"), /main moved to m\+1\+99 under #2, .* starting a new round/);
});

test("a check no pull request in the batch needs doesn't run", async () => {
  const { deps, ran, lines } = queue();
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, ["merge #1 onto m", "verify s:m+1", "land s:m+1"]);
  assert.match(lines.join("\n"), /no pull request needs web; skipping it/);
});

test("a unit red once and green on its rerun lands the batch and is reported flaky with the pull requests that selected it", async () => {
  const { deps, ran, dropped, flaky, lines } = queue({
    prs: [pr(1), pr(2)],
    specs: { 1: ["zones.spec.ts", "org-zone.spec.ts"], 2: ["zones.spec.ts", "billing.spec.ts"] },
    flakyRuns: 1,
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.deepEqual(ran.slice(3, 5), [
    "specs s:m+1+2 billing.spec.ts org-zone.spec.ts zones.spec.ts",
    "specs s:m+1+2 billing.spec.ts org-zone.spec.ts zones.spec.ts",
  ]);
  assert.deepEqual(flaky, [
    { unit: "billing.spec.ts", prs: [2] },
    { unit: "org-zone.spec.ts", prs: [1] },
    { unit: "zones.spec.ts", prs: [1, 2] },
  ]);
  assert.ok(lines.some((line) => line.startsWith("merge-queue: green on retry")));
});

test("a unit red twice drops the pull request that selected it, marking its head, and the rest land", async () => {
  const { deps, ran, dropped, flaky, failed } = queue({
    prs: [pr(1), pr(2)],
    specs: { 1: ["orders.spec.ts"], 2: ["billing.spec.ts"] },
    breaksSpec: { 1: "orders.spec.ts" },
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(flaky, []);
  assert.deepEqual(
    dropped.map(({ number }) => number),
    [1],
  );
  assert.equal(dropped[0]?.reason.summary, "web failed twice on main plus this pull request");
  assert.deepEqual(dropped[0]?.reason.details, ["failed: orders.spec.ts", "test branch s:m+1+2"]);
  assert.deepEqual(failed, ["#1 web: orders.spec.ts failed on main plus this pull request"]);
  assert.deepEqual(ran.slice(3, 5), [
    "specs s:m+1+2 billing.spec.ts orders.spec.ts",
    "specs s:m+1+2 orders.spec.ts",
  ]);
  assert.equal(ran.at(-1), "land s:m+2");
});

test("a red check that runs whole drops the batch it ran on", async () => {
  const { deps, ran, dropped, failed, records } = queue({
    prs: [pr(1), pr(2)],
    breaksVerify: [1],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, ["merge #1 onto m", "merge #2 onto m", "verify s:m+1+2"]);
  assert.deepEqual(
    dropped.map(({ number }) => number),
    [1, 2],
  );
  assert.equal(dropped[0]?.reason.summary, "checks failed on main plus the batch it was tested in");
  assert.equal(
    dropped[0]?.reason.details?.[1],
    "batch: [#1 🔀](https://github.com/o/app/pull/1), [#2 🔀](https://github.com/o/app/pull/2)",
  );
  assert.deepEqual(failed, [], "a whole check can't say which head broke it");
  assert.equal(records[0]?.outcome, "failed");
});

test("a pull request that conflicts with main is dropped before anything runs, and the rest go on", async () => {
  const { deps, ran, dropped } = queue({ prs: [pr(1), pr(2)], conflictsWithMain: [1] });
  assert.equal(await runQueue(deps), 0);
  assert.equal(dropped[0]?.number, 1);
  assert.equal(dropped[0]?.reason.summary, "it conflicts with main in a.ts");
  assert.deepEqual(ran.slice(2), ["verify s:m+2", "land s:m+2"]);
});

test("a pull request that deletes a guarded script or file is dropped before it's built, and the rest go on", async () => {
  const { deps, ran, dropped } = queue({
    prs: [pr(1), pr(2), pr(3)],
    removes: { 1: { scripts: ["signoff"] }, 3: { files: [".github/workflows/ci.yml"] } },
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(
    dropped.map(({ number }) => number),
    [1, 3],
  );
  assert.match(
    dropped[0]!.reason.next ?? "",
    /`removal-ok` label once quality control explains it, and turns auto-merge back on/,
  );
  assert.deepEqual(dropped[0]!.reason.details, ["removed script: signoff"]);
  assert.deepEqual(dropped[1]!.reason.details, ["deleted: .github/workflows/ci.yml"]);
  assert.deepEqual(ran, ["merge #2 onto m", "verify s:m+2", "land s:m+2"]);
});

test("a pull request with an open review thread or changes requested waits untested, with no status or comment, and the rest land", async () => {
  const { deps, ran, dropped, lines, failed } = queue({
    prs: [pr(1), pr(2)],
    reviews: {
      2: ["open review thread at a.ts:3 by reviewbot: Fix this.", "a reviewer requested changes"],
    },
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, ["merge #1 onto m", "verify s:m+1", "land s:m+1"]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(failed, []);
  assert.ok(
    lines.includes(
      "merge-queue: #2 waits on its review, untested; it rejoins once resolved: open review thread at a.ts:3 by reviewbot: Fix this.; a reviewer requested changes",
    ),
  );
  assert.equal(lines.at(-1), "merge-queue: Landed: #1. Dropped: none. Waiting: #2.");
});

test("a pull request with the removal label lands what it removes", async () => {
  const { deps, ran, dropped } = queue({
    prs: [pr(1, { labels: ["removal-ok"] })],
    removes: { 1: { scripts: ["signoff"] } },
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.deepEqual(ran, ["merge #1 onto m", "verify s:m+1", "land s:m+1"]);
});

test("a pull request that conflicts with an earlier one waits for it to land, then goes", async () => {
  const { deps, ran, dropped } = queue({ prs: [pr(1), pr(2)], conflictsWithEarlier: [2] });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.deepEqual(
    ran.filter((step) => step.startsWith("land")),
    ["land s:m+1", "land s:m+1+2"],
  );
});

test("a branch pushed to before the queue's push starts over without dropping it", async () => {
  const { deps, ran, dropped } = queue({ landing: { 1: ["moved"] } });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.deepEqual(
    ran.filter((step) => step.startsWith("land")),
    ["land s:m+1", "land s:m+1"],
  );
});

test("a failed push or status, or a merge GitHub never makes, drops the pull request with why", async () => {
  const failed = queue({ landing: { 1: [{ failed: "posting signoff/web failed" }] } });
  await runQueue(failed.deps);
  assert.equal(failed.dropped[0]?.reason.summary, "posting signoff/web failed");
  const stuck = queue({ merging: { 1: [{ stuck: "open, blocked" }] } });
  await runQueue(stuck.deps);
  assert.match(stuck.dropped[0]!.reason.summary, /GitHub didn't merge it .*\(open, blocked\)/);
});

test("auto-merge turned off by hand while the queue waits leaves the pull request alone", async () => {
  const { deps, dropped, lines } = queue({ merging: { 1: ["dequeued"] } });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.match(lines.join("\n"), /auto-merge was turned off on #1/);
  assert.match(lines.join("\n"), /#1 left the queue, still open/);
});

test("main moving before GitHub merges starts over instead of dropping the pull request", async () => {
  const { deps, ran, dropped, lines } = queue({ merging: { 1: ["behind"] } });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.deepEqual(
    ran.filter((step) => step.startsWith("land")),
    ["land s:m+1", "land s:m+1"],
  );
  assert.match(lines.join("\n"), /main moved before GitHub merged #1; starting over/);
});

test("a queue that keeps moving under it stops after a fixed number of rounds and fails", async () => {
  const { deps, lines } = queue({ landing: { 1: Array(30).fill("moved") } });
  assert.equal(await runQueue(deps), 1);
  assert.match(lines.at(-2)!, /stopped after 20 rounds/);
  assert.equal(lines.at(-1), "merge-queue: Landed: none. Dropped: none.");
});

test("the log says each check that passed and each sign-off, and the summary names what landed, as the file step reads them", async () => {
  const { deps, lines } = queue({ prs: [pr(1), pr(2)], specs: { 1: ["zones.spec.ts"] } });
  assert.equal(await runQueue(deps), 0);
  const log = lines.join("\n");
  assert.match(log, /^merge-queue: test branch s:m\+1\+2 is main m plus #1, #2$/m);
  assert.match(log, /checks passed on s:m\+1\+2/);
  assert.match(log, /web passed on s:m\+1\+2/);
  assert.match(log, /#1 signed off; merging it\n.*#1 merged/);
  assert.match(lines.at(-1)!, /Landed: #1, #2\. Dropped: none\./);
});

test("a pull request another run merges while this one tests it is logged and listed as merged outside this run, not as landed", async () => {
  const { deps, ran, lines } = queue({
    prs: [pr(1), pr(2)],
    specs: { 1: ["zones.spec.ts"] },
    mergedOutside: { 1: "web" },
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(
    ran.filter((step) => step.startsWith("land")),
    ["land s:m+1+2"],
  );
  assert.match(lines.join("\n"), /#1 merged outside this run/);
  assert.match(lines.at(-1)!, /Landed: #2\. Merged outside this run: #1\. Dropped: none\./);
});

test("a pull request this run signed off counts as landed when GitHub merges it after the wait gave up", async () => {
  const { deps, lines } = queue({ mergedOutside: { 1: "waiting" } });
  assert.equal(await runQueue(deps), 0);
  assert.match(
    lines.join("\n"),
    /main moved before GitHub merged #1; starting over\n.*#1 merged$/m,
  );
  assert.match(lines.at(-1)!, /Landed: #1\. Dropped: none\./);
});

test("a pull request dropped because GitHub hadn't merged it yet counts as landed once GitHub merges it", async () => {
  const { deps, dropped, lines } = queue({ merging: { 1: [{ stuck: "open, blocked" }] } });
  deps.state = () => "merged";
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(
    dropped.map(({ number }) => number),
    [1],
  );
  assert.match(lines.join("\n"), /#1 merged after the queue stopped waiting on it/);
  assert.match(lines.at(-1)!, /Landed: #1\. Dropped: none\./);
});

test("a queue stopped by an error or a signal still says what it landed and dropped", async () => {
  const { deps, ran, lines } = queue({
    prs: [pr(1), pr(2)],
    specs: { 3: ["zones.spec.ts"] },
    conflictsWithMain: [2],
  });
  const queued = deps.queued;
  deps.queued = () => [
    ...queued(),
    ...(ran.some((step) => step.startsWith("land")) ? [pr(3)] : []),
  ];
  const runCheck = deps.runCheck;
  deps.runCheck = async (check, sha, ...rest) => {
    if (sha.includes("+3") && check.name === "web") throw new Error("stopped by SIGTERM");
    return runCheck(check, sha, ...rest);
  };
  await assert.rejects(runQueue(deps), /stopped by SIGTERM/);
  assert.equal(lines.at(-1), "merge-queue: Landed: #1. Dropped: #2.");
});

const chat = ["chat"];
const signIn = ["sign-in"];

test("a pull request that needs a check this machine can't run waits for one that can, untested, and the rest land", async () => {
  const { deps, ran, dropped, lines, failed } = queue({
    prs: [pr(1), pr(2)],
    flows: { 2: chat },
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran, ["merge #1 onto m", "merge #2 onto m", "verify s:m+1", "land s:m+1"]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(failed, []);
  assert.ok(
    lines.includes(
      "merge-queue: #2 needs device (chat), which this machine can't run: it runs no device flows (studio does)",
    ),
  );
  assert.equal(lines.at(-1), "merge-queue: Landed: #1. Dropped: none. Waiting: #2.");
});

test("where the machine can, the batch's units run once on the test branch after the checks before them, and a batch needing none skips it", async () => {
  const { deps, ran, failed } = queue({
    prs: [pr(1), pr(2), pr(3)],
    specs: { 1: ["zones.spec.ts"] },
    flows: { 1: chat, 2: ["chat", "sign-in"] },
    device: [],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran.slice(3, 6), [
    "verify s:m+1+2+3",
    "specs s:m+1+2+3 zones.spec.ts",
    "flows s:m+1+2+3 chat sign-in (attempt 0)",
  ]);
  assert.equal(ran.filter((step) => step.startsWith("land")).length, 3);
  assert.deepEqual(failed, []);

  const none = queue({ device: [] });
  await runQueue(none.deps);
  assert.ok(!none.ran.some((step) => step.startsWith("flows")));
  assert.ok(none.lines.includes("merge-queue: no pull request needs device; skipping it"));
});

test("a unit that fails twice drops only the pull requests that need it, and the rest land on a new test branch", async () => {
  const red = { failed: ["chat"], notRun: [] };
  const { deps, ran, dropped, failed } = queue({
    prs: [pr(1), pr(2), pr(3)],
    flows: { 1: chat, 2: signIn },
    device: [red, red],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran.slice(3, 6), [
    "verify s:m+1+2+3",
    "flows s:m+1+2+3 chat sign-in (attempt 0)",
    "flows s:m+1+2+3 chat (attempt 1)",
  ]);
  assert.deepEqual(
    dropped.map(({ number, reason }) => [number, reason.summary, reason.details?.[0]]),
    [[1, "device failed twice on main plus this pull request", "failed: chat"]],
  );
  assert.deepEqual(failed, ["#1 device: chat failed on main plus this pull request"]);
  assert.ok(ran.includes("verify s:m+2+3"));
  assert.ok(ran.includes("flows s:m+2+3 sign-in (attempt 0)"));
  assert.deepEqual(
    ran.filter((step) => step.startsWith("land")),
    ["land s:m+2", "land s:m+2+3"],
  );
});

test("a unit that fails once and passes on its rerun lands", async () => {
  const { deps, ran, dropped } = queue({
    flows: { 1: chat },
    device: [{ failed: ["chat"], notRun: [] }],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(ran.slice(-3), [
    "flows s:m+1 chat (attempt 0)",
    "flows s:m+1 chat (attempt 1)",
    "land s:m+1",
  ]);
  assert.deepEqual(dropped, []);
});

test("a check that can't run here leaves what needs it waiting, never dropped, and the rest land", async () => {
  const held = "/elsewhere holds the simulator. Stop it there";
  const { deps, ran, dropped, lines } = queue({
    prs: [pr(1), pr(2)],
    flows: { 1: chat },
    device: [{ unavailable: held }],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.ok(lines.includes(`merge-queue: #1 can't run its device here: ${held}`));
  assert.deepEqual(
    ran.filter((step) => step.startsWith("land")),
    ["land s:m+2"],
  );
  assert.equal(lines.at(-1), "merge-queue: Landed: #2. Dropped: none. Waiting: #1.");
});

test("a waiting pull request merged or dequeued meanwhile isn't summarized as waiting", async () => {
  const { deps, lines } = queue({
    prs: [pr(1), pr(2)],
    specs: { 1: ["zones.spec.ts"] },
    flows: { 2: chat },
    mergedOutside: { 2: "web" },
  });
  assert.equal(await runQueue(deps), 0);
  assert.ok(lines.includes("merge-queue: #2 merged outside this run"));
  assert.equal(
    lines.at(-1),
    "merge-queue: Landed: #1. Merged outside this run: #2. Dropped: none.",
  );
});

test("a unit that didn't finish and then fails on the rerun gets a rerun of its own before its pull requests drop", async () => {
  const { deps, ran, dropped } = queue({
    prs: [pr(1), pr(2)],
    flows: { 1: chat, 2: signIn },
    device: [
      { failed: ["chat"], notRun: ["sign-in"] },
      { failed: ["sign-in"], notRun: [] },
    ],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(
    ran.filter((step) => step.startsWith("flows")),
    [
      "flows s:m+1+2 chat sign-in (attempt 0)",
      "flows s:m+1+2 chat sign-in (attempt 1)",
      "flows s:m+1+2 sign-in (attempt 2)",
    ],
  );
  assert.deepEqual(dropped, []);
  assert.equal(ran.filter((step) => step.startsWith("land")).length, 2);
});

test("a unit still unsettled after the last run leaves the pull requests that need it waiting", async () => {
  const { deps, dropped, lines } = queue({
    flows: { 1: chat },
    device: [
      { failed: [], notRun: ["chat"] },
      { failed: [], notRun: ["chat"] },
      { failed: [], notRun: ["chat"] },
    ],
  });
  assert.equal(await runQueue(deps), 0);
  assert.deepEqual(dropped, []);
  assert.ok(
    lines.includes("merge-queue: #1 its device chat neither passed nor failed for good on s:m+1"),
  );
  assert.equal(lines.at(-1), "merge-queue: Landed: none. Dropped: none. Waiting: #1.");
});
