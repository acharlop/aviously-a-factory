import assert from "node:assert/strict";
import { test } from "node:test";

import { limitFromText, parseReset, readable, type StreamEvent, summarize } from "./stream.ts";

// Monday 2026-10-12 10:00 in Jerusalem (UTC+3).
const NOW = Date.UTC(2026, 9, 12, 7, 0);
const at = (iso: string) => Date.parse(iso) / 1000;

test("a reset time in a named zone later today", () => {
  assert.equal(parseReset("resets 3pm (Asia/Jerusalem)", NOW), at("2026-10-12T12:00:00Z"));
  assert.equal(parseReset("resets at 3:30 PM (Asia/Jerusalem)", NOW), at("2026-10-12T12:30:00Z"));
});

test("a reset time already past today is tomorrow", () => {
  assert.equal(parseReset("resets 9am (Asia/Jerusalem)", NOW), at("2026-10-13T06:00:00Z"));
  assert.equal(parseReset("resets 12am (UTC)", NOW), at("2026-10-13T00:00:00Z"));
});

test("a reset date and time", () => {
  assert.equal(parseReset("resets Oct 14, 9am (Asia/Jerusalem)", NOW), at("2026-10-14T06:00:00Z"));
  assert.equal(
    parseReset("spend limit reached (daily; resets 2026-10-13 00:00 UTC)", NOW),
    at("2026-10-13T00:00:00Z"),
  );
});

test("a reset in a duration", () => {
  assert.equal(parseReset("limit resets in 2h 5m", NOW), NOW / 1000 + 2 * 3600 + 300);
});

test("a reset that doesn't read as a time", () => {
  assert.equal(parseReset("resets soon", NOW), undefined);
});

test("limit texts", () => {
  assert.deepEqual(limitFromText("Claude AI usage limit reached|1760300000", NOW), {
    resetsAt: 1760300000,
  });
  assert.deepEqual(limitFromText("You've hit your limit · resets 3pm (Asia/Jerusalem)", NOW), {
    resetsAt: at("2026-10-12T12:00:00Z"),
  });
  assert.deepEqual(limitFromText("Usage limit reached", NOW), { resetsAt: NOW / 1000 + 3600 });
  assert.equal(limitFromText("Opened #12 and turned on auto-merge.", NOW), undefined);
  assert.equal(limitFromText("Context limit reached while reading the log", NOW), undefined);
});

const assistant = (content: object[], parent: string | null = null): StreamEvent => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: content as never },
});
const result = (extra: Partial<StreamEvent> = {}): StreamEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 12,
  total_cost_usd: 1.5,
  result: "Memo: https://github.com/owner/trail/issues/3",
  modelUsage: {
    "claude-opus": {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
    },
    "claude-haiku": {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    },
  },
  ...extra,
});

test("a finished shift: its session, tokens across models, agents hired, no limit", () => {
  const summary = summarize(
    [
      { type: "system", subtype: "init", session_id: "abc", model: "opus" },
      assistant([{ type: "tool_use", name: "Agent", input: { subagent_type: "temp" } }]),
      assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }], "toolu_1"),
      assistant([{ type: "tool_use", name: "Task", input: {} }]),
      result(),
    ],
    NOW,
  );
  assert.equal(summary.session, "abc");
  assert.equal(summary.agents, 2);
  assert.equal(summary.tokens, 380);
  assert.equal(summary.turns, 12);
  assert.equal(summary.limitResetsAt, undefined);
});

test("a shift stopped by the usage limit takes the reset from the rate limit event", () => {
  const summary = summarize(
    [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1760320000 } },
      result({ is_error: true, result: "Usage limit reached · limit resets 5pm" }),
    ],
    NOW,
  );
  assert.equal(summary.limitResetsAt, 1760320000);
});

test("a rejected window the shift got past on a fallback model is not a stop", () => {
  const summary = summarize(
    [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1760320000 } },
      result(),
    ],
    NOW,
  );
  assert.equal(summary.limitResetsAt, undefined);
});

test("a shift cut off before its result, after a rejected window", () => {
  const summary = summarize(
    [
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1760320000000 },
      },
    ],
    NOW,
  );
  assert.equal(summary.limitResetsAt, 1760320000);
});

test("readable lines", () => {
  assert.deepEqual(
    readable(
      assistant([
        {
          type: "tool_use",
          name: "Agent",
          input: { subagent_type: "temp", description: "519 build" },
        },
      ]),
    ),
    ["foreman tool Agent temp: 519 build"],
  );
  assert.deepEqual(readable(assistant([{ type: "text", text: "Done\n\nall green" }], "toolu_1")), [
    "agent: Done all green",
  ]);
  assert.deepEqual(readable({ type: "user" }), []);
});
