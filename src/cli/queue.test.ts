import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { parseArgs } from "./queue.ts";

test("the queue's run folder is --run-dir, else FACTORY_RUN_DIR, as the foreman skill calls it", () => {
  assert.equal(parseArgs([], { FACTORY_RUN_DIR: "/runs/today" })?.runDir, "/runs/today");
  assert.equal(
    parseArgs(["--run-dir", "here"], { FACTORY_RUN_DIR: "/x" })?.runDir,
    resolve("here"),
  );
  assert.equal(parseArgs([], {})?.runDir, undefined);
  assert.equal(parseArgs(["--run-dir"], {}), undefined);
  assert.equal(parseArgs(["--nope"], {}), undefined);
});
