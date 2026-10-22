import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { durations, type Mark, readMarks } from "../runtime/marks.ts";
import type { Agent } from "../runtime/transcripts.ts";
import {
  agentTimeout,
  mark,
  newlyOverdue,
  overdue,
  overdueAgents,
  timingsReport,
} from "./timings.ts";

const at = (minute: number) => Date.UTC(2026, 9, 12, 9, minute);

const marked = (step: string, event: Mark["event"], minute: number, key?: string): Mark => ({
  step: step as Mark["step"],
  event,
  at: new Date(at(minute)).toISOString(),
  ...(key && { key }),
});

const agent = (overrides: Partial<Agent>): Agent => ({
  id: "a1",
  ticket: "1",
  step: "build",
  type: "aviously-a-factory:temp",
  running: true,
  turns: 1,
  read: 0,
  written: 0,
  peak: 0,
  start: at(0),
  end: at(0),
  ...overrides,
});

test("an agent's timeout comes from its step's first word, else from its agent, whichever inspector it is", () => {
  assert.equal(agentTimeout({ step: "quality-control: spec", type: "-" }), "TIMEOUT_REVIEW");
  assert.equal(agentTimeout({ step: "rework", type: "aviously-a-factory:temp" }), "TIMEOUT_FIX");
  assert.equal(
    agentTimeout({ step: "spec", type: "aviously-a-factory:spec-inspector" }),
    "TIMEOUT_REVIEW",
  );
  assert.equal(agentTimeout({ step: "copy-desk", type: "-" }), "TIMEOUT_STRINGS");
  assert.equal(agentTimeout({ step: "facts", type: "aviously-a-factory:intern" }), undefined);
});

test("a step of the latest shift still open past its timeout is overdue, from the config or the default", () => {
  const marks = [
    marked("queue", "start", 0, "9"),
    marked("run", "start", 1),
    marked("queue", "start", 2, "1"),
  ];
  assert.deepEqual(overdue(marks, {}, at(45)), ["queue\t1\t43 min\tpast TIMEOUT_QUEUE 40"]);
  assert.deepEqual(overdue(marks, { TIMEOUT_QUEUE: "50" }, at(45)), []);
  assert.deepEqual(overdue(marks, {}, at(10)), []);
});

test("a step restarted under the same ticket counts from its latest start, and its end closes it", () => {
  const restarted = [
    marked("run", "start", 0),
    marked("queue", "start", 1, "1"),
    marked("queue", "start", 20, "1"),
  ];
  assert.deepEqual(overdue(restarted, {}, at(50)), []);
  const ended = [...restarted, marked("queue", "end", 45, "1")];
  assert.deepEqual(overdue(ended, {}, at(90)), []);
  assert.deepEqual(durations(ended).get("queue"), [25]);
});

test("a running agent past its step's timeout is overdue, oldest first; a finished one never is", () => {
  const agents = [
    agent({ ticket: "2", step: "quality-control: spec", start: at(20) }),
    agent({ ticket: "1", step: "build", start: at(0) }),
    agent({ ticket: "3", step: "rework", running: false, start: at(0) }),
    agent({ ticket: "4", step: "copy-desk", start: at(5) }),
    agent({ ticket: "5", step: "facts", type: "aviously-a-factory:intern", start: at(0) }),
  ];
  assert.deepEqual(overdueAgents(agents, {}, at(40)), [
    "build\t1\t40 min\tpast TIMEOUT_CODER 30",
    "copy-desk\t4\t35 min\tpast TIMEOUT_STRINGS 15",
    "quality-control: spec\t2\t20 min\tpast TIMEOUT_REVIEW 15",
  ]);
  assert.deepEqual(overdueAgents(agents, { TIMEOUT_CODER: "45", TIMEOUT_REVIEW: "30" }, at(40)), [
    "copy-desk\t4\t35 min\tpast TIMEOUT_STRINGS 15",
  ]);
});

test("a watch reports each overdue agent once, as it passes its timeout", () => {
  const agents = [
    agent({ id: "c", ticket: "1", step: "build", start: at(0) }),
    agent({ id: "f", ticket: "2", step: "rework", start: at(20) }),
  ];
  const seen = new Set<string>();
  assert.deepEqual(newlyOverdue(agents, {}, seen, at(31)), [
    "build\t1\t31 min\tpast TIMEOUT_CODER 30",
  ]);
  assert.deepEqual(newlyOverdue(agents, {}, seen, at(33)), []);
  assert.deepEqual(newlyOverdue(agents, {}, seen, at(46)), [
    "rework\t2\t26 min\tpast TIMEOUT_FIX 25",
  ]);
});

test("the report puts anything overdue above each step's median minutes", () => {
  const marks = [marked("run", "start", 0), marked("run", "end", 12)];
  assert.deepEqual(timingsReport(marks, [], {}, at(20)), [
    "# step\tmedian minutes\truns",
    "queue\t-\t0 runs",
    "run\t12.0\t1 runs",
  ]);
  assert.equal(
    timingsReport(marks, [agent({})], {}, at(40))[0],
    "# OVERDUE: step\tticket\trunning\ttimeout",
  );
});

test("a mark is a JSON line in the marks file", () => {
  const file = join(mkdtempSync(join(tmpdir(), "factory-marks-")), "p", "timings.jsonl");
  mark(file, "run", "start", undefined, new Date(at(0)));
  mark(file, "queue", "end", "7", new Date(at(5)));
  assert.deepEqual(readMarks(file), [marked("run", "start", 0), marked("queue", "end", 5, "7")]);
});
