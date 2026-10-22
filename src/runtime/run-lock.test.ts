import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { takeRunLock } from "./run-lock.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "factory-run-lock-")), "lock");

test("a free lock is taken with the pid and step, and released once", () => {
  const lock = fresh();
  const release = takeRunLock("queue", lock, 4242);
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), "4242\n");
  assert.equal(readFileSync(join(lock, "step"), "utf8"), "queue\n");
  release();
  release();
  assert.ok(!existsSync(lock));
});

test("a lock a shift holds stays as it is, before and after", () => {
  const lock = fresh();
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), "17\n");
  writeFileSync(join(lock, "step"), "shift\n");
  takeRunLock("queue", lock, 4242)();
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), "17\n");
  assert.equal(readFileSync(join(lock, "step"), "utf8"), "shift\n");
});

test("a lock someone else took over meanwhile is left to them", () => {
  const lock = fresh();
  const release = takeRunLock("queue", lock, 4242);
  writeFileSync(join(lock, "pid"), "99\n");
  release();
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), "99\n");
});
