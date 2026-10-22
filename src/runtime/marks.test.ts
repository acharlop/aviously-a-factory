import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { durations, type Mark, marksFile, median, readMarks, stepMedians } from "./marks.ts";

const at = (minute: number) => Date.UTC(2026, 9, 12, 9, minute);

const mark = (step: string, event: Mark["event"], minute: number, key?: string): Mark => ({
  step: step as Mark["step"],
  event,
  at: new Date(at(minute)).toISOString(),
  ...(key && { key }),
});

test("marks are read from the project's timings file, none when it is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "factory-marks-"));
  const file = marksFile("p", home);
  assert.deepEqual(readMarks(file), []);
  mkdirSync(join(home, "p"));
  writeFileSync(file, `${JSON.stringify(mark("run", "start", 0))}\n`);
  assert.deepEqual(readMarks(file), [mark("run", "start", 0)]);
});

test("an end pairs with its step's latest open start, per ticket when one is named", () => {
  const marks = [
    mark("queue", "start", 0, "1"),
    mark("queue", "start", 5, "2"),
    mark("queue", "end", 20, "1"),
    mark("queue", "end", 45, "2"),
    mark("run", "end", 50),
    mark("run", "start", 50),
  ];
  assert.deepEqual(durations(marks).get("queue"), [20, 40]);
  assert.equal(durations(marks).get("run"), undefined, "an end with no start before it is skipped");
});

test("a step restarted under the same key counts from its latest start", () => {
  const marks = [
    mark("queue", "start", 1, "1"),
    mark("queue", "start", 20, "1"),
    mark("queue", "end", 45, "1"),
  ];
  assert.deepEqual(durations(marks).get("queue"), [25]);
});

test("marks of steps that are not timed are skipped", () => {
  assert.equal(durations([mark("coder", "start", 0, "1"), mark("coder", "end", 20, "1")]).size, 0);
});

test("the median is the middle duration, or the mean of the middle two", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 40, 20, 30]), 25);
});

test("the medians list queue then run, a dash for one never timed", () => {
  assert.deepEqual(stepMedians([mark("run", "start", 0), mark("run", "end", 12)]), [
    "# step\tmedian minutes\truns",
    "queue\t-\t0 runs",
    "run\t12.0\t1 runs",
  ]);
});
