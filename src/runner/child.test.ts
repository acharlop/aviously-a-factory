import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runJob } from "./child.ts";

// 0.01 min is 600 ms.
const CAP = 0.01;

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-child-"));
  return { dir, prefix: join(dir, "job"), done: () => rmSync(dir, { recursive: true }) };
};

const waitDead = (pid: number) => {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
      spawnSync("sleep", ["0.1"]);
    } catch {
      return true;
    }
  }
  return false;
};

test("a job past its cap is stopped and its outcome says so", async () => {
  const { prefix, done } = scratch();
  const started = Date.now();
  const outcome = await runJob({ prefix, command: "sleep", args: ["30"], capMinutes: CAP });
  assert.ok(Date.now() - started < 10_000);
  assert.equal(outcome.exit, 143);
  assert.equal(outcome.timedOut, true);
  assert.deepEqual(JSON.parse(readFileSync(`${prefix}.json`, "utf8")), outcome);
  assert.match(readFileSync(`${prefix}.log`, "utf8"), /the cap, 0.01 min/);
  done();
});

test("a job that ignores TERM is killed once the kill delay passes", async () => {
  const { prefix, done } = scratch();
  // exec, so no orphaned sleep holds the pipes open after bash is killed.
  const outcome = await runJob(
    { prefix, command: "bash", args: ["-c", "trap '' TERM; exec sleep 30"], capMinutes: CAP },
    500,
  );
  assert.equal(outcome.exit, 137);
  assert.equal(outcome.timedOut, true);
  assert.match(
    readFileSync(`${prefix}.log`, "utf8"),
    /process group still running 0.5 s after SIGTERM: SIGKILL/,
  );
  done();
});

test("what a job leaves running after a normal exit is gone once it is reaped", async () => {
  const { dir, prefix, done } = scratch();
  const pidFile = join(dir, "grandchild.pid");
  // It keeps the job's stdout, as a server started with & would.
  const outcome = await runJob(
    { prefix, command: "bash", args: ["-c", `sleep 60 & echo $! >${pidFile}`] },
    500,
  );
  assert.equal(outcome.exit, 0);
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(waitDead(grandchild), `pid ${grandchild} outlived the job`);
  done();
});

test("the cap kills what the job started even when it ignores TERM", async () => {
  const { dir, prefix, done } = scratch();
  const pidFile = join(dir, "grandchild.pid");
  const outcome = await runJob(
    {
      prefix,
      command: "bash",
      args: [
        "-c",
        `bash -c "trap '' TERM; exec sleep 60" >/dev/null 2>&1 & echo $! >${pidFile}; wait`,
      ],
      capMinutes: CAP,
    },
    500,
  );
  assert.equal(outcome.exit, 143);
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(waitDead(grandchild), `pid ${grandchild} outlived the stop`);
  assert.match(readFileSync(`${prefix}.log`, "utf8"), /SIGKILL/);
  done();
});

test("a job inside its cap has no timedOut, and Claude's stream becomes its summary", async () => {
  const { prefix, done } = scratch();
  const lines = [
    { type: "system", subtype: "init", session_id: "s1", model: "opus" },
    { type: "result", subtype: "success", num_turns: 3, result: "Filed the memo." },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const outcome = await runJob({
    prefix,
    command: "bash",
    args: ["-c", `printf '%s\\n' '${lines.replace(/\n/g, "' '")}'`],
    capMinutes: 1,
    claude: true,
  });
  assert.equal(outcome.exit, 0);
  assert.equal(outcome.timedOut, undefined);
  assert.equal(outcome.summary?.session, "s1");
  assert.equal(outcome.summary?.turns, 3);
  assert.match(readFileSync(`${prefix}.log`, "utf8"), /result success: Filed the memo\./);
  assert.equal(readFileSync(`${prefix}.jsonl`, "utf8").trim().split("\n").length, 2);
  done();
});

test("a command that can't start exits 127", async () => {
  const { prefix, done } = scratch();
  const outcome = await runJob({ prefix, command: join(tmpdir(), "no-such-claude"), args: [] });
  assert.equal(outcome.exit, 127);
  done();
});
