import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { untriaged } from "./untriaged.ts";

test("untriaged prints one number and title per unrouted open ticket", async () => {
  const calls: string[][] = [];
  const sh: Exec = (command, args) => {
    calls.push([command, ...args]);
    const stdout = JSON.stringify([
      { number: 7, title: "Routed", labels: [{ name: "Parked" }] },
      { number: 9, title: "New one", labels: [{ name: "kind:bug" }] },
      { number: 2, title: "Older", labels: [] },
    ]);
    return { status: 0, stdout, stderr: "" };
  };
  const log = mock.method(console, "log", () => {});
  try {
    assert.equal(await untriaged([], sh), 0);
    assert.deepEqual(
      log.mock.calls.map((call) => call.arguments[0]),
      ["2\tOlder", "9\tNew one"],
    );
  } finally {
    log.mock.restore();
  }
  assert.deepEqual(calls, [
    ["gh", "issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,labels"],
  ]);
});
