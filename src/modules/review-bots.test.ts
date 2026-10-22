import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig, resolveConfig } from "../config/load.ts";
import { describe, type PrView, standings } from "./review-bots.ts";
import type { ReviewBots } from "./schema.ts";

const BOTS: ReviewBots["bots"] = {
  greptile: {
    login: "greptile-apps[bot]",
    verdict: "greptile_confidence_score:(\\d)",
    pass: "^[45]$",
    threads: "findings",
  },
  coderabbit: { login: "coderabbitai", threads: "advisory" },
};

const view = (body: string, reviews: [string, string][] = []): PrView => ({
  body,
  reviews: reviews.map(([login, text]) => ({ author: { login }, body: text })),
  comments: [],
});

test("a bot that has said nothing is pending, and nothing is settled", () => {
  const [greptile, coderabbit] = standings(BOTS, view("Fixes it"), []);
  assert.deepEqual(
    [greptile, coderabbit].map((each) => [each!.reviewed, each!.settled]),
    [
      [false, false],
      [false, false],
    ],
  );
  assert.equal(describe(greptile!), "greptile\tpending\t-\t-");
});

test("a verdict is read from the PR body, and must pass; a findings bot's open threads hold it, an advisory bot's don't", () => {
  const body = "<!-- greptile_confidence_score:4 -->";
  const reviews: [string, string][] = [
    ["greptile-apps", ""],
    ["coderabbitai", "**Actionable comments posted: 1**"],
  ];
  const threads = [
    { where: "a.ts:3", author: "greptile-apps", said: "Null check" },
    { where: "b.ts:9", author: "coderabbitai", said: "Nit" },
  ];
  const [greptile, coderabbit] = standings(BOTS, view(body, reviews), threads);
  assert.equal(greptile!.verdict, "4");
  assert.deepEqual([greptile!.passed, greptile!.settled], [true, false]);
  assert.equal(describe(greptile!), "greptile\tthreads open\t4\ta.ts:3: Null check");
  assert.deepEqual([coderabbit!.open, coderabbit!.settled], [["b.ts:9: Nit"], true]);
  const [low] = standings(BOTS, view("<!-- greptile_confidence_score:2 -->", reviews), []);
  assert.deepEqual([low!.passed, low!.settled], [false, false]);
  assert.equal(describe(low!), "greptile\tfailed\t2\t-");
});

test("the module takes bots by name, needs at least one, and refuses a bad regex", () => {
  const resolved = (reviewBots: object) =>
    resolveConfig(parseConfig({ configVersion: 1, modules: { reviewBots } }), "/p");
  assert.equal(
    resolved({ bots: { coderabbit: { login: "coderabbitai" } } }).modules.reviewBots !== "none",
    true,
  );
  assert.throws(() => resolved({ bots: {} }), /at least one bot/);
  assert.throws(
    () => resolved({ bots: { g: { login: "g", verdict: "(" } } }),
    /regular expression/,
  );
});
