import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  cost,
  currentSession,
  findSession,
  handBack,
  invocation,
  invokesFactory,
  label,
  latestSession,
  readShift,
  totals,
  usage,
  usageLine,
} from "./transcripts.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 21, minute)).toISOString();

const reply = (
  id: string,
  minute: number,
  read: [number, number, number],
  output: number,
  content: unknown[] = [{ type: "text", text: "..." }],
) => ({
  type: "assistant",
  timestamp: at(minute),
  message: {
    id,
    content,
    usage: {
      input_tokens: read[0],
      cache_read_input_tokens: read[1],
      cache_creation_input_tokens: read[2],
      output_tokens: output,
    },
  },
});

const said = (content: unknown, minute: number) => ({
  type: "user",
  timestamp: at(minute),
  message: { role: "user", content },
});

const stopped = (id: string, minute: number) => ({
  type: "user",
  timestamp: at(minute),
  message: {
    role: "user",
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
  },
});

const jsonl = (records: readonly unknown[]) =>
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "factory-transcripts-"));
  const subagents = join(dir, "run-1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(
    join(dir, "run-1.jsonl"),
    jsonl([
      { type: "mode", mode: "normal" },
      said(
        "<command-message>factory</command-message>\n<command-name>/factory</command-name>\n<command-args>unsupervised 7</command-args>",
        0,
      ),
      reply("lead-1", 1, [2, 1_000, 30_000], 3),
      reply("lead-1", 1, [2, 1_000, 30_000], 50),
      reply("lead-2", 30, [1, 40_000, 2_000], 80),
      stopped("c0de", 25),
      {
        type: "cost-state",
        totalCostUSD: 1.5,
        modelUsage: {
          opus: {
            inputTokens: 10,
            outputTokens: 400,
            thinkingTokens: 90,
            cacheReadInputTokens: 2_000,
            cacheCreationInputTokens: 500,
          },
        },
      },
      "not json",
      "",
    ]),
  );
  writeFileSync(
    join(subagents, "agent-c0de.meta.json"),
    JSON.stringify({ agentType: "temp", description: "7 build" }),
  );
  writeFileSync(
    join(subagents, "agent-c0de.jsonl"),
    jsonl([
      said("brief", 2),
      reply("c-1", 3, [3, 0, 20_000], 10),
      reply("c-2", 22, [1, 20_000, 5_000], 20),
      said("result", 24),
    ]),
  );
  writeFileSync(
    join(subagents, "agent-beef.meta.json"),
    JSON.stringify({ agentType: "inspector", description: "7 inspect: spec" }),
  );
  writeFileSync(
    join(subagents, "agent-beef.jsonl"),
    jsonl([said("brief", 26), reply("r-1", 28, [5, 1_000, 9_000], 5)]),
  );
  writeFileSync(
    join(dir, "other.jsonl"),
    jsonl([said("fix the build", 0), reply("o-1", 1, [1, 1, 1], 1)]),
  );
  return dir;
}

test("a reply split over several records counts once with its largest output, and its biggest prompt is the peak", () => {
  const counted = usage(
    jsonl([
      reply("m1", 0, [2, 100, 10], 1),
      reply("m1", 0, [2, 100, 10], 7),
      reply("m1", 0, [2, 100, 10], 4),
      reply("m2", 5, [1, 300, 0], 3),
      said("ok", 6),
    ]),
  );
  assert.deepEqual(counted, {
    turns: 2,
    read: 413,
    written: 10,
    peak: 301,
    start: Date.parse(at(0)),
    end: Date.parse(at(6)),
  });
});

test("a description `<ticket> <step>` gives both; another shape keeps its first number as the ticket", () => {
  assert.deepEqual(label("656 inspect: spec"), { ticket: "656", step: "inspect: spec" });
  assert.deepEqual(label("Rework 655"), { ticket: "655", step: "Rework 655" });
  assert.deepEqual(label("research the queue"), { ticket: "-", step: "research the queue" });
  assert.deepEqual(label(""), { ticket: "-", step: "-" });
});

test("a shift reads one row per agent, running until the foreman hears it stop, and totals with the foreman", () => {
  const dir = fixture();
  const shift = readShift(dir, "run-1", Date.parse(at(40)));
  assert.deepEqual(
    shift.agents.map(({ ticket, step, running, turns, read, peak }) => ({
      ticket,
      step,
      running,
      turns,
      read,
      peak,
    })),
    [
      { ticket: "7", step: "build", running: false, turns: 2, read: 45_004, peak: 25_001 },
      { ticket: "7", step: "inspect: spec", running: true, turns: 1, read: 10_005, peak: 10_005 },
    ],
  );
  assert.equal(shift.foreman.turns, 2, "the foreman's split reply counts once");
  assert.deepEqual(totals(shift), { wall: 30, turns: 5, read: 128_012, written: 165 });
  assert.equal(
    usageLine(shift),
    "wall 30 min · 128k tokens read, ≥165 written · 2 agents · foreman 73k read, 73k per ticket (1), peak context 42k",
  );
  const unticketed = { ...shift, agents: shift.agents.map((agent) => ({ ...agent, ticket: "-" })) };
  assert.match(usageLine(unticketed), /· foreman 73k read, peak context 42k$/);
  assert.deepEqual(shift.cost, { read: 2_510, written: 400, thinking: 90, usd: 1.5 });
  assert.equal(cost(jsonl([said("hi", 0)])), undefined);
});

test("a session that did other work first counts only from the latest shift start before its end", () => {
  const dir = fixture();
  const mark = (minute: number) => ({
    step: "run" as const,
    event: "start" as const,
    at: at(minute),
  });
  const marks = [mark(-90), mark(25), { step: "run" as const, event: "end" as const, at: at(31) }];
  const shift = readShift(dir, "run-1", Date.parse(at(40)), [...marks, mark(45)]);
  assert.equal(shift.start, Date.parse(at(25)));
  assert.deepEqual(
    shift.earlier.map(({ step }) => step),
    ["build"],
  );
  assert.deepEqual(totals(shift), { wall: 5, turns: 2, read: 52_006, written: 85 });
  assert.equal(
    readShift(dir, "run-1", Date.parse(at(40)), [mark(45)]).earlier.length,
    0,
    "a start after the session ended is another shift's",
  );
});

test("with no session named, the newest transcript that invoked the factory is the shift", () => {
  const dir = fixture();
  utimesSync(join(dir, "other.jsonl"), new Date(), new Date(Date.now() + 60_000));
  assert.equal(latestSession(dir), "run-1");
  assert.equal(latestSession(join(dir, "missing")), undefined);
  assert.ok(invokesFactory(jsonl([said([{ type: "text", text: "/factory lights-out 7" }], 0)])));
  assert.ok(!invokesFactory(jsonl([said("how does /factory work?", 0)])));
});

test("the shell's own session wins over the newest shift when its transcript is here", () => {
  const dir = fixture();
  utimesSync(join(dir, "other.jsonl"), new Date(), new Date(Date.now() + 60_000));
  assert.equal(currentSession(dir, { CLAUDE_CODE_SESSION_ID: "other" }), "other");
  assert.equal(currentSession(dir, { CLAUDE_CODE_SESSION_ID: "elsewhere" }), "run-1");
  assert.equal(currentSession(dir, {}), "run-1");
});

test("a session is named by its full id or a unique prefix; an ambiguous or unknown one is refused", () => {
  const dir = fixture();
  writeFileSync(join(dir, "9fb74978-1111.jsonl"), "");
  writeFileSync(join(dir, "9fb74978-2222.jsonl"), "");
  assert.equal(findSession(dir, "run-1"), "run-1");
  assert.equal(findSession(dir, "run"), "run-1");
  assert.equal(findSession(dir, "9fb74978-1"), "9fb74978-1111");
  assert.match((findSession(dir, "9fb74978") as { error: string }).error, /names 2 transcripts/);
  assert.match((findSession(dir, "nope") as { error: string }).error, /no factory transcript nope/);
});

test("a session that starts with /model before /factory is still a shift", () => {
  const caveat = {
    ...said("<local-command-caveat>The command below was run directly.</local-command-caveat>", 0),
    isMeta: true,
  };
  const model = said(
    "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
    0,
  );
  const set = said("<local-command-stdout>Set model to `Opus`</local-command-stdout>", 0);
  const factory = said(
    "<command-message>factory</command-message>\n<command-name>/factory</command-name>\n<command-args>supervised 7</command-args>",
    1,
  );
  assert.ok(invokesFactory(jsonl([caveat, model, set, factory, reply("a", 2, [1, 1, 1], 1)])));
  assert.ok(
    !invokesFactory(
      jsonl([caveat, model, set, said("fix the build", 1), reply("a", 2, [1, 1, 1], 1), factory]),
    ),
    "a /factory after the first reply is a mention mid-session, not the shift",
  );
});

test("a shift the runner started, under a project's skill name or the plugin's, keeps its mode", () => {
  for (const skill of ["yarcone-factory", "factory"]) {
    const prompt = `Invoke the ${skill} skill with args \`unsupervised 2\` and follow it to its report.`;
    assert.match(
      invocation(jsonl([said(prompt, 0), reply("lead-1", 1, [1, 1, 1], 1)])) ?? "",
      /\bunsupervised\b/,
    );
  }
});

test("a stray first prompt doesn't hide the shift's mode: the first record invoking the factory gives it", () => {
  const transcript = jsonl([
    said("hi", 0),
    reply("lead-1", 1, [1, 1, 1], 1),
    said(
      "<command-name>/yarcone-factory</command-name>\n<command-args>lights-out 3</command-args>",
      2,
    ),
    said("/yarcone-factory supervised", 3),
  ]);
  assert.match(invocation(transcript) ?? "", /lights-out 3/);
});

test("a project's /<name>-factory and the plugin's /<plugin>:factory are shifts; a mention of the skill is not", () => {
  assert.ok(
    invokesFactory(
      jsonl([
        said("<command-name>/yarcone-factory</command-name>\n<command-args>7</command-args>", 0),
      ]),
    ),
  );
  assert.ok(invokesFactory(jsonl([said("/aviously-a-factory:factory 3", 0)])));
  assert.ok(!invokesFactory(jsonl([said("why did the factory skill stop?", 0)])));
});

const handback = (id: string, minute: number) =>
  reply(id, minute, [1, 1, 1], 1, [
    { type: "tool_use", name: "SubagentHandback", input: { message: "pushed" } },
  ]);

function foreground(records: readonly unknown[]) {
  const dir = fixture();
  const subagents = join(dir, "run-1", "subagents");
  writeFileSync(
    join(subagents, "agent-f00d.meta.json"),
    JSON.stringify({ agentType: "temp", description: "7 push" }),
  );
  writeFileSync(join(subagents, "agent-f00d.jsonl"), jsonl(records));
  return readShift(dir, "run-1", Date.parse(at(50))).agents.find((a) => a.id === "f00d");
}

test("a foreground agent that sent its SubagentHandback is done at its last record, with no stop notice", () => {
  const push = foreground([said("brief", 31), handback("p-1", 33)]);
  assert.equal(push?.running, false);
  assert.equal(push?.end, Date.parse(at(33)));
});

test("a foreground agent resumed with SendMessage after its SubagentHandback is running again", () => {
  const push = foreground([
    said("brief", 31),
    handback("p-1", 33),
    said("one more fix", 35),
    reply("p-2", 36, [1, 1, 1], 1),
  ]);
  assert.equal(push?.running, true);
  assert.equal(push?.end, Date.parse(at(50)));
});

test("an agent's report is its SubagentHandback message, else its last reply's text", () => {
  const record = (content: unknown) => JSON.stringify({ type: "assistant", message: { content } });
  const transcript = [
    record([{ type: "text", text: "working" }]),
    record([
      {
        type: "tool_use",
        name: "SubagentHandback",
        input: { message: "Bugs fixed from review:\n- one" },
      },
    ]),
  ].join("\n");
  assert.equal(handBack(transcript), "Bugs fixed from review:\n- one");
  assert.equal(handBack(record([{ type: "text", text: "done" }])), "done");
});
