import assert from "node:assert/strict";
import { test } from "node:test";

import { skipped } from "../../../cli/gate.ts";
import { parseConfig, resolveConfig } from "../../../config/load.ts";
import { repo } from "./checkout.fixture.ts";
import { runQueue } from "./queue.ts";

const resolved = (config: object) =>
  resolveConfig(parseConfig({ configVersion: 1, ...config }), "/p");

test("merge@1 runs unless the project pins it none or local", () => {
  assert.equal(skipped(resolved({}), "merge"), undefined);
  assert.match(skipped(resolved({ steps: { merge: "none" } }), "merge")!, /merge step is none/);
  assert.match(
    skipped(resolved({ steps: { merge: { local: "merge.ts" } } }), "merge")!,
    /merge step is local \(\/p\/merge\.ts\)/,
  );
});

test("merge@1's config defaults: squash, pnpm's frozen install, nothing linked, no fixups, no removal guard", () => {
  assert.deepEqual(resolved({}).merge, {
    method: "squash",
    install: "pnpm install --frozen-lockfile --config.confirm-modules-purge=false",
    links: [],
    needs: [],
    fixups: [],
    removals: { files: [], scripts: false, label: "removal-ok" },
  });
  assert.throws(() => resolved({ merge: { fixups: [{ module: "nope" }] } }), /no module/);
  assert.throws(() => resolved({ merge: { method: "fast-forward" } }));
});

const queued = JSON.stringify([
  {
    number: 1,
    title: "PR 1",
    url: "https://github.com/o/app/pull/1",
    headRefName: "topic/1",
    labels: [],
    baseRefName: "main",
    isDraft: false,
    isCrossRepository: false,
    autoMergeRequest: { enabledAt: "2026-10-12T01:00:00Z" },
  },
]);
const settled = JSON.stringify([
  { data: { repository: { pullRequest: { reviewDecision: null, reviewThreads: { nodes: [] } } } } },
]);

test("merge@1 lands a queued pull request through the gate's checks: a status per check under the gate's prefix, a sign-off per check run, and the project's merge method", async () => {
  const gh: Record<string, string[]> = {
    "api graphql": [settled],
    "pr view": [JSON.stringify({ state: "OPEN", autoMergeRequest: {}, mergeStateStatus: "CLEAN" })],
  };
  const fake = repo({ gate: { status: "queue/" }, merge: { method: "rebase" }, gh });
  const listed = queued.replace('"labels"', `"headRefOid":"${fake.pr(1).headRefOid}","labels"`);
  // The queue lists it to build it, again before it lands it, and finds it gone after.
  gh["pr list"] = [listed, listed, "[]"];
  assert.equal(await runQueue(fake.deps), 0);
  const posted = fake.asked
    .filter(({ args }) => args.includes("--method"))
    .map(({ args }) => args.find((arg) => arg.startsWith("context=")));
  assert.deepEqual(posted, ["context=queue/checks", "context=queue/web"]);
  assert.deepEqual(fake.asked.find(({ args }) => args[1] === "merge")?.args, [
    "pr",
    "merge",
    "1",
    "--rebase",
    "--delete-branch",
  ]);
  assert.deepEqual(
    fake.records.map(({ check, outcome }) => [check, outcome]),
    [
      ["checks", "passed"],
      ["web", "passed"],
    ],
  );
  assert.match(fake.lines.at(-1)!, /Landed: #1\. Dropped: none\./);
});
