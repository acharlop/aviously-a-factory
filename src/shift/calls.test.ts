import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bashGroups, calls, callsReport, groups, heavy, readCalls } from "./calls.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 21, minute)).toISOString();

const toolUse = (id: string, minute: number, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  timestamp: at(minute),
  message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] },
});

const result = (id: string, minute: number, content: unknown) => ({
  type: "user",
  timestamp: at(minute),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});

const jsonl = (records: readonly unknown[]) =>
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

const kb = (n: number) => "x".repeat(n * 1024);

const commands = heavy(["pnpm verify:web", "pnpm e2e:spec"]);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "factory-calls-"));
  const subagents = join(dir, "s-1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(
    join(dir, "s-1.jsonl"),
    jsonl([
      toolUse("sweep", 0, "Bash", { command: "gh issue list --label to-discuss" }),
      result("sweep", 1, kb(50)),
      toolUse("push", 20, "Bash", { command: "cd /wt && pnpm verify:web && git push -u origin b" }),
      result("push", 28, kb(2)),
      toolUse("spawn", 21, "Agent", { description: "7 build", prompt: "..." }),
      result("spawn", 21, [{ type: "text", text: "launched" }]),
      toolUse("hung", 29, "Bash", { command: "sleep 100" }),
    ]),
  );
  writeFileSync(
    join(subagents, "agent-c0de.meta.json"),
    JSON.stringify({ agentType: "aviously-a-factory:temp", description: "7 build" }),
  );
  writeFileSync(
    join(subagents, "agent-c0de.jsonl"),
    jsonl([
      toolUse("t", 22, "Bash", { command: "pnpm --filter @app/tooling test" }),
      result("t", 24, [{ type: "text", text: kb(1) }]),
      toolUse("r", 27, "Read", { file_path: "/wt/a.ts" }),
      result("r", 27, kb(8)),
      toolUse("s", 27, "Bash", { command: "FORCE_COLOR=0 git status -sb" }),
      result("s", 27, "clean"),
    ]),
  );
  return dir;
}

test("a chained command counts under each heavy command it runs, the project's first; one with none, under the rest", () => {
  assert.deepEqual(groups("cd /wt && pnpm verify:web && git push -u origin b", commands), [
    "pnpm verify:web",
    "git push",
  ]);
  assert.deepEqual(groups("pnpm verify:web-all", commands), ["the rest"]);
  assert.deepEqual(groups("cd packages/x && node --test a.test.ts", commands), ["package tests"]);
  assert.deepEqual(groups("pnpm e2e:spec tests/board.spec.ts", commands), ["pnpm e2e:spec"]);
  assert.deepEqual(groups("cd /wt && git status -sb", commands), ["the rest"]);
});

test("a call is timed from its tool_use to its tool_result, sized by its output, and one with no result is left out", () => {
  assert.deepEqual(
    calls(jsonl([toolUse("a", 1, "Read", { file_path: "/x" }), result("a", 3, "abc")]), "foreman"),
    [
      {
        agent: "foreman",
        tool: "Read",
        start: Date.parse(at(1)),
        ms: 120_000,
        bytes: 3,
        target: "/x",
      },
    ],
  );
  const shift = readCalls(fixture(), "s-1");
  assert.equal(shift.calls.length, 6);
  assert.ok(!shift.calls.some((c) => c.target === "sleep 100"));
});

test("the report groups Bash by what it runs, then the slowest calls and largest outputs, from the shift's start", () => {
  const shift = readCalls(fixture(), "s-1", [{ step: "run", event: "start", at: at(10) }]);
  assert.ok(!shift.calls.some((c) => c.target.startsWith("gh issue list")));
  assert.deepEqual(
    bashGroups(shift.calls, commands).map(({ name, count, ms, bytes }) => [
      name,
      count,
      ms / 60_000,
      bytes,
    ]),
    [
      ["pnpm verify:web", 1, 8, 2048],
      ["pnpm e2e:spec", 0, 0, 0],
      ["git push", 1, 8, 2048],
      ["package tests", 1, 2, 1024],
      ["the rest", 1, 0, 5],
    ],
  );
  const lines = callsReport(shift, commands);
  assert.equal(lines[0], `# session s-1 · shift from ${at(10)} · 5 calls`);
  const slowest = lines.indexOf("# slowest: agent\ttool\tminutes\toutput KB\tcommand or path");
  assert.equal(
    lines[slowest + 1],
    "foreman\tBash\t8.0\t2.0\tcd /wt && pnpm verify:web && git push -u origin b",
  );
  const largest = lines.findIndex((l) => l.startsWith("# largest output"));
  assert.equal(lines[largest + 1], "7 build\tRead\t0.0\t8.0\t/wt/a.ts");
});
