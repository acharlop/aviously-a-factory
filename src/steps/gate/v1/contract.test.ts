import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { skipped } from "../../../cli/gate.ts";
import { parseConfig, resolveConfig } from "../../../config/load.ts";
import { projectChecks } from "../../../runtime/checks.ts";
import { exec, type Exec } from "../../../runtime/exec.ts";
import type { SignOff } from "../../file/v1/sign-off.ts";
import { signOff } from "./sign-off.ts";

const resolved = (config: object) =>
  resolveConfig(parseConfig({ configVersion: 1, ...config }), "/p");

const gate = {
  base: "trunk",
  status: "gate/",
  checks: {
    lint: { run: "true" },
    specs: { run: "true", select: "echo a.spec.ts #", when: ["src/**"] },
  },
};

test("gate@1 runs unless the project pins it none or local", () => {
  assert.equal(skipped(resolved({ gate }), "gate"), undefined);
  assert.match(skipped(resolved({ steps: { gate: "none" } }), "gate")!, /gate step is none/);
  assert.match(
    skipped(resolved({ steps: { gate: { local: "gate.ts" } } }), "gate")!,
    /gate step is local \(\/p\/gate\.ts\)/,
  );
});

/** A topic branch on top of the project's base branch, pushed to a bare origin. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "factory-gate-contract-"));
  const work = join(root, "work");
  exec("git", ["init", "--quiet", "--bare", "-b", "trunk", join(root, "origin.git")]);
  exec("git", ["clone", "--quiet", join(root, "origin.git"), work]);
  const git = (...args: string[]) => exec("git", args, { cwd: work }).stdout.trim();
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(work, "readme.md"), "hi\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "first");
  git("push", "--quiet", "origin", "HEAD:trunk");
  git("checkout", "--quiet", "-b", "topic");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "a.ts"), "a\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "a");
  git("push", "--quiet", "origin", "topic");
  return { work, git };
}

test("gate@1 leaves the branch pushed with a status per configured check under the configured prefix, and a sign-off per check", async () => {
  const { work, git } = project();
  const posted: string[] = [];
  const sh: Exec = (command, args, options) => {
    if (command === "gh" && args[0] === "api") {
      posted.push(args.find((arg) => arg.startsWith("context="))!);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "gh") return { status: 0, stdout: "[]", stderr: "" };
    return exec(command, args, { cwd: work, ...options });
  };
  const config = resolved({ gate }).gate;
  const checks = projectChecks(config, { root: work, machine: {}, sh });
  const records: SignOff[] = [];
  const code = await signOff({
    sh,
    checks,
    docs: config.docs,
    base: `origin/${config.base}`,
    status: config.status,
    passed: () => false,
    lock: async () => () => {},
    run: async () => ({ failed: [] }),
    log: () => {},
    record: (record) => (records.push(record), undefined),
  });
  assert.equal(code, 0);
  assert.equal(git("rev-parse", "origin/topic"), git("rev-parse", "HEAD"));
  assert.deepEqual(posted, ["context=gate/lint", "context=gate/specs"]);
  assert.deepEqual(
    records.map(({ check, outcome, base }) => [check, outcome, base]),
    [
      ["lint", "passed", "origin/trunk"],
      ["specs", "passed", "origin/trunk"],
    ],
  );
  assert.equal(records[1]!.command, "true a.spec.ts");
});
