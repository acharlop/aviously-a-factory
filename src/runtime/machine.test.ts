import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadMax,
  machineConfig,
  mobileSignoff,
  parseSettings,
  queueOn,
  queuePeer,
  shiftCount,
  timeoutMinutes,
} from "./machine.ts";

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-machine-"));
  mkdirSync(join(dir, "p"));
  return dir;
};

test("settings are KEY=value lines, as a shell runner sources them", () => {
  const settings = parseSettings(
    [
      "# jarvis",
      "QUEUE=on",
      "export FACTORY_TICKETS=2",
      'TIMEOUT_E2E="25"  # slow',
      "not one",
    ].join("\n"),
  );
  assert.deepEqual(settings, { QUEUE: "on", FACTORY_TICKETS: "2", TIMEOUT_E2E: "25" });
});

test("a project's config overrides the machine-wide one", () => {
  const dir = home();
  assert.deepEqual(machineConfig("p", dir), {});
  writeFileSync(join(dir, "machine"), "QUEUE=on\nLOAD_MAX=8\n");
  writeFileSync(join(dir, "p", "config"), "QUEUE=off\n");
  assert.deepEqual(machineConfig("p", dir), { QUEUE: "off", LOAD_MAX: "8" });
  assert.deepEqual(machineConfig("other", dir), { QUEUE: "on", LOAD_MAX: "8" });
});

test("the queue runs only where QUEUE=on, and a missing or bad timeout falls back to its default", () => {
  assert.equal(queueOn({}), false);
  const config = parseSettings("QUEUE=on\nTIMEOUT_VERIFY=abc\nTIMEOUT_E2E=25\n");
  assert.equal(queueOn(config), true);
  assert.equal(timeoutMinutes(config, "TIMEOUT_VERIFY"), 10);
  assert.equal(timeoutMinutes(config, "TIMEOUT_E2E"), 25);
  assert.equal(timeoutMinutes(config, "TIMEOUT_QUEUE"), 40);
});

test("the mobile flows run only where MOBILE_SIGNOFF=on", () => {
  assert.equal(mobileSignoff({}), false);
  assert.equal(mobileSignoff({ MOBILE_SIGNOFF: "off" }), false);
  assert.equal(mobileSignoff({ MOBILE_SIGNOFF: "on" }), true);
});

test("QUEUE_PEER names the other queue machine, and an empty or missing one is none", () => {
  assert.equal(queuePeer(parseSettings("QUEUE_PEER=shield-tower\n")), "shield-tower");
  assert.equal(queuePeer(parseSettings("QUEUE_PEER=\n")), undefined);
  assert.equal(queuePeer({}), undefined);
});

test("LOAD_MAX defaults to twice the cores", () => {
  assert.equal(loadMax({}, 4), 8);
  assert.equal(loadMax({ LOAD_MAX: "6" }, 4), 6);
});

test("the shift count is RUN_COUNT in the project's state, 0 before the first shift", () => {
  const dir = home();
  assert.equal(shiftCount("p", dir), 0);
  writeFileSync(join(dir, "p", "state"), "RUN_COUNT=7\n");
  assert.equal(shiftCount("p", dir), 7);
});
