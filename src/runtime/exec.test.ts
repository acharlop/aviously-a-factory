import assert from "node:assert/strict";
import { test } from "node:test";

import { exec } from "./exec.ts";

test("exec returns the status and what the command printed, stdin included", () => {
  assert.deepEqual(exec("node", ["-e", "process.stdin.pipe(process.stdout)"], { input: "hi" }), {
    status: 0,
    stdout: "hi",
    stderr: "",
  });
  assert.equal(exec("node", ["-e", "process.exit(3)"]).status, 3);
});

test("a command that can't start fails with its error, never throws", () => {
  const result = exec("factory-no-such-command", []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});
