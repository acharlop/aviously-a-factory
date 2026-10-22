import assert from "node:assert/strict";
import { test } from "node:test";

import { skipped } from "../../../cli/gate.ts";
import { parseConfig, resolveConfig } from "../../../config/load.ts";
import type { Exec } from "../../../runtime/exec.ts";
import { queueOutcomes } from "../../file/v1/memo.ts";
import { queueStats } from "../../file/v1/timesheet.ts";
import { earlierQueued, type NativeDeps, type NativePr, standing, tend } from "./native.ts";
import { requiredChecks } from "./required.ts";

const resolved = (config: object) =>
  resolveConfig(parseConfig({ configVersion: 1, ...config }), "/p");

const pr = (number: number, more: Partial<NativePr> = {}): NativePr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/app/pull/${number}`,
  baseRefName: "main",
  isDraft: false,
  autoMergeRequest: { enabledAt: "2026-10-22T09:00:00Z" },
  mergeStateStatus: "BLOCKED",
  statusCheckRollup: [
    { name: "Quality gate", status: "COMPLETED", conclusion: "SUCCESS" },
    { context: "netlify/deploy-preview", state: "SUCCESS" },
  ],
  ...more,
});

const required = { checks: ["Quality gate", "netlify/deploy-preview"], strict: true };
const none = () => [];

test("merge@2 is a version a project pins, and runs unless pinned none or local", () => {
  assert.equal((resolved({ steps: { merge: 2 } }).steps.merge as { version: number }).version, 2);
  assert.equal(skipped(resolved({ steps: { merge: 2 } }), "merge"), undefined);
  assert.match(skipped(resolved({ steps: { merge: "none" } }), "merge")!, /none/);
});

test("merge@2 drops a conflicting pull request or one whose required check failed, ignoring checks that aren't required", () => {
  assert.equal(standing(pr(1, { mergeStateStatus: "DIRTY" }), required, none).action, "drop");
  const failed = pr(2, {
    statusCheckRollup: [
      { name: "Quality gate", status: "COMPLETED", conclusion: "FAILURE" },
      { context: "netlify/deploy-preview", state: "SUCCESS" },
    ],
  });
  assert.deepEqual(standing(failed, required, none), {
    action: "drop",
    summary: "Quality gate failed",
  });
  const optional = pr(3, {
    statusCheckRollup: [
      ...pr(3).statusCheckRollup,
      { name: "Pages changed", status: "COMPLETED", conclusion: "FAILURE" },
    ],
  });
  assert.equal(standing(optional, required, none).action, "wait");
});

test("merge@2 brings a pull request behind the base up to date, and waits on pending checks, then on review, then on GitHub", () => {
  assert.deepEqual(standing(pr(1, { mergeStateStatus: "BEHIND" }), required, none), {
    action: "update",
  });
  const pending = pr(2, {
    statusCheckRollup: [{ name: "Quality gate", status: "IN_PROGRESS", conclusion: null }],
  });
  assert.deepEqual(standing(pending, required, none), {
    action: "wait",
    why: "waits on Quality gate, netlify/deploy-preview",
  });
  assert.match(
    (
      standing(pr(3), required, () => ["open review thread at a.ts:1 by greptile-apps: Nit"]) as {
        why: string;
      }
    ).why,
    /^waits on review: open review thread at a\.ts:1/,
  );
  assert.match((standing(pr(4), required, none) as { why: string }).why, /GitHub merges it/);
});

function deps(open: NativePr[], more: Partial<NativeDeps> = {}) {
  const lines: string[] = [];
  const done: string[] = [];
  const all: NativeDeps = {
    base: "main",
    log: (line) => lines.push(`2026-10-22T10:00:00.000Z ${line}`),
    open: () => open,
    required,
    reviews: none,
    update: (each) => (done.push(`update #${each.number}`), undefined),
    drop: (each, { summary }) => done.push(`drop #${each.number}: ${summary}`),
    earlier: [],
    merged: () => true,
    dryRun: false,
    ...more,
  };
  return { all, lines, done };
}

test("merge@2's pass lands nothing itself: it names what merged since, updates, drops and waits, in the queue log the memo and timesheet read", () => {
  const behind = pr(2, { mergeStateStatus: "BEHIND" });
  const dirty = pr(3, { mergeStateStatus: "DIRTY" });
  const draft = pr(4, { isDraft: true });
  const off = pr(5, { autoMergeRequest: null });
  const { all, lines, done } = deps([behind, dirty, draft, off, pr(6)], { earlier: [1, 2] });
  assert.equal(tend(all), 0);
  assert.deepEqual(done, ["update #2", "drop #3: it conflicts with main"]);
  const log = lines.join("\n");
  assert.deepEqual(queueOutcomes(log, 0, "o/app"), [
    "Landed: [#1 🔀](https://github.com/o/app/pull/1). Dropped: [#3 🔀](https://github.com/o/app/pull/3). Waiting: [#2 🔀](https://github.com/o/app/pull/2), [#6 🔀](https://github.com/o/app/pull/6).",
  ]);
  const stats = queueStats(log, 0, Date.parse("2026-10-23"));
  assert.equal(stats.drops, 1);
  assert.deepEqual([...stats.landed], [1]);
  assert.deepEqual(earlierQueued(log).sort(), [2, 6]);
});

test("merge@2's dry run changes nothing", () => {
  const { all, lines, done } = deps([pr(2, { mergeStateStatus: "BEHIND" })], { dryRun: true });
  tend(all);
  assert.deepEqual(done, []);
  assert.match(lines[0]!, /#2 would be brought up to date with main/);
});

test("the required checks are the base's rulesets' and its branch protection's together; none when GitHub has neither", () => {
  const answers: Record<string, { status: number; stdout: string; stderr: string }> = {
    "repos/{owner}/{repo}/rules/branches/main": {
      status: 0,
      stdout: JSON.stringify([
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: "Quality gate" }, { context: "Website e2e" }],
          },
        },
      ]),
      stderr: "",
    },
    "repos/{owner}/{repo}/branches/main/protection/required_status_checks": {
      status: 1,
      stdout: "",
      stderr: "gh: Branch not protected (HTTP 404)",
    },
  };
  const sh: Exec = (_, args) => answers[args[1]!] ?? { status: 1, stdout: "", stderr: "HTTP 404" };
  assert.deepEqual(requiredChecks("main", sh), {
    checks: ["Quality gate", "Website e2e"],
    strict: true,
  });
  assert.deepEqual(requiredChecks("trunk", sh), { checks: [], strict: false });
  const broken: Exec = () => ({ status: 1, stdout: "", stderr: "HTTP 502" });
  assert.throws(() => requiredChecks("main", broken), /HTTP 502/);
});
