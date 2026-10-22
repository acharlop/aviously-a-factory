import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Stamp } from "./record.ts";
import { recorder, type SignOff, signOffRecorder, turboCache } from "./sign-off.ts";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const URL = "https://github.com/o/paper-trail/blob/main/sign-offs/one.json";

const trail: PaperTrail = {
  repo: "o/paper-trail",
  timesheet: "timesheets/shifts.jsonl",
  signOffs: "sign-offs",
  memoLabel: "memo",
};

const stamp: Stamp = {
  person: "octo",
  machine: "jarvis",
  step: "file@1",
  factory: "0.2.0",
  steps: ["file@1"],
};

test("the recorder commits one stamped file per sign-off and tails a failed check's log", () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "factory-sign-off-")), "web.log");
  writeFileSync(logFile, Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
  const calls: { args: string[]; input?: string }[] = [];
  const record = recorder(
    trail,
    stamp,
    new Map([["web", { logFile, nextCacheAgeHours: 2.5 }]]),
    () => {},
    (args, input) => {
      calls.push({ args, input });
      return { status: 0, stdout: `${URL}\n` };
    },
  );
  const signOff: SignOff = {
    outcome: "failed",
    check: "web",
    sha: SHA,
    branch: "topic",
    base: "origin/main",
    startedAt: "2026-10-06T00:00:00.000Z",
  };
  assert.equal(record(signOff), URL);
  record({ ...signOff, outcome: "passed" });
  assert.equal(calls.length, 2);
  assert.match(
    calls[0]!.args[3]!,
    /^repos\/o\/paper-trail\/contents\/sign-offs\/\d{4}-\d{2}-\d{2}\/\d{4}-.+Z-abcdef01-web-octo\.json$/,
  );
  const { message, content } = JSON.parse(calls[0]!.input!);
  assert.equal(message, "web failed on abcdef01");
  const body = JSON.parse(Buffer.from(content, "base64").toString());
  assert.equal(body.person, "octo");
  assert.equal(body.machine.name, "jarvis");
  assert.equal(typeof body.machine.hostname, "string");
  assert.equal(typeof body.machine.cores, "number");
  assert.equal(body.step, "file@1");
  assert.equal(body.factory, "0.2.0");
  assert.deepEqual(body.steps, ["file@1"]);
  assert.deepEqual(body.cache, { nextAgeHours: 2.5 });
  assert.equal(body.logTail.split("\n").length, 200);
  assert.match(body.logTail, /^line 100\n[^]*line 299$/);
  const passed = JSON.parse(Buffer.from(JSON.parse(calls[1]!.input!).content, "base64").toString());
  assert.equal(passed.logTail, undefined);
});

test("a recorder that can't reach GitHub logs one line and stops trying", () => {
  for (const gh of [
    () => ({ status: 1, stdout: "" }),
    () => {
      throw new Error("spawn gh ENOENT");
    },
  ]) {
    const lines: string[] = [];
    let calls = 0;
    const record = recorder(
      trail,
      stamp,
      new Map(),
      (line) => lines.push(line),
      () => (calls++, gh()),
    );
    const refused = { outcome: "refused", reason: "dirty", base: "origin/main" } as const;
    assert.equal(record(refused), undefined);
    const afterFirst = calls;
    assert.equal(record(refused), undefined);
    assert.equal(calls, afterFirst);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^sign-off: couldn't file the sign-off in o\/paper-trail/);
  }
});

test("a project with no paper trail gets a recorder that files nothing and says why once", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-sign-off-project-"));
  writeFileSync(join(root, "factory.config.ts"), "export default { configVersion: 1 };");
  const lines: string[] = [];
  const record = await signOffRecorder(new Map(), (line) => lines.push(line), root);
  assert.equal(record({ outcome: "passed", base: "origin/main" }), undefined);
  assert.deepEqual(lines, ["sign-off: paperTrail is none in factory.config.ts; nothing filed"]);
});

test("turbo's cache lines are summed across the check's turbo runs", () => {
  assert.deepEqual(
    turboCache(
      " Tasks:    18 successful, 18 total\nCached:    16 cached, 18 total\n...\nCached:    0 cached, 16 total\n",
    ),
    { cached: 16, total: 34 },
  );
  assert.equal(turboCache("no turbo here"), undefined);
});
