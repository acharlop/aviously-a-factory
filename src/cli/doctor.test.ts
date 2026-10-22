import assert from "node:assert/strict";
import { test } from "node:test";

import { nodeCheck, pluginCheck } from "./doctor.ts";

test("node 24.15 or later passes", () => {
  assert.equal(nodeCheck("24.15.0").ok, true);
  assert.equal(nodeCheck("26.0.1").ok, true);
  assert.equal(nodeCheck("24.14.9").ok, false);
  assert.equal(nodeCheck("22.20.0").ok, false);
});

test("the plugin must be installed at the CLI's version", () => {
  assert.equal(pluginCheck("0.1.0", "0.1.0").ok, true);
  assert.match(pluginCheck("0.1.0", "0.2.0").detail, /plugin is 0.1.0 but the CLI is 0.2.0/);
  assert.equal(pluginCheck(undefined, "0.1.0").ok, false);
});
