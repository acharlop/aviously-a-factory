import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const main = new URL("./main.ts", import.meta.url).pathname;

const factory = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [main, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "factory-cli-")),
    encoding: "utf8",
    env: { ...process.env, FACTORY_DEBUG: "", ...env },
  });

test("a failing command prints one line naming itself, not a stack", () => {
  const run = factory(["resolve"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^factory resolve: no factory\.config\.ts here or above /);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test("FACTORY_DEBUG shows the stack", () => {
  assert.match(factory(["resolve"], { FACTORY_DEBUG: "1" }).stderr, /\n\s+at /);
});

test("an unknown command prints the usage and fails", () => {
  const run = factory(["nope"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Usage: factory <command>/);
});
