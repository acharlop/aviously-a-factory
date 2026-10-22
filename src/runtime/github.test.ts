import assert from "node:assert/strict";
import { test } from "node:test";

import type { Exec } from "./exec.ts";
import { gh, graphql, machine, person, searchIssues, who } from "./github.ts";

test("the factory names this machine one way: the short hostname, lowercased after the gh login", () => {
  const sh: Exec = () => ({ status: 0, stdout: "acharlop\n", stderr: "" });
  assert.equal(machine("SHIELD-Tower.local"), "SHIELD-Tower");
  assert.equal(machine("jarvis"), "jarvis");
  assert.equal(person(sh), "acharlop");
  assert.equal(who(sh, "SHIELD-Tower.local"), "acharlop@shield-tower");
  assert.equal(who(sh, "Jarvis.local"), "acharlop@jarvis");
});

test("gh throws with its own error when it fails", () => {
  const sh: Exec = () => ({ status: 1, stdout: "", stderr: "HTTP 404: Not Found\n" });
  assert.throws(
    () => gh(["issue", "view", "1"], sh),
    /^Error: gh issue view: HTTP 404: Not Found$/,
  );
});

test("graphql passes numbers with -F and strings with -f", () => {
  let seen: string[] = [];
  const sh: Exec = (_, args) => {
    seen = args;
    return { status: 0, stdout: '{"data":{"ok":true}}', stderr: "" };
  };
  assert.deepEqual(graphql("query", { q: "is:open", n: 3 }, sh), { ok: true });
  assert.deepEqual(seen.slice(4), ["-f", "q=is:open", "-F", "n=3"]);
});

test("a search reads every page", () => {
  const page = (numbers: number[]) => ({
    data: { search: { nodes: numbers.map((number) => ({ number })) } },
  });
  const sh: Exec = () => ({
    status: 0,
    stdout: JSON.stringify([page([1, 2]), page([3])]),
    stderr: "",
  });
  assert.deepEqual(
    searchIssues<{ number: number }>("repo:o/r", "number", sh).map(({ number }) => number),
    [1, 2, 3],
  );
});
