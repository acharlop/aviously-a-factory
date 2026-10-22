import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installedPluginVersion } from "./plugin.ts";
import { FACTORY_VERSION, pluginManifestVersion } from "./version.ts";

const claudeHome = (plugins: object) => {
  const home = mkdtempSync(join(tmpdir(), "factory-claude-"));
  mkdirSync(join(home, "plugins"));
  writeFileSync(
    join(home, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }),
  );
  return home;
};

test("the plugin manifest and the CLI are the same release", () => {
  assert.equal(pluginManifestVersion(), FACTORY_VERSION);
});

test("a project-scoped install for this project wins over a user-scoped one", () => {
  const home = claudeHome({
    "aviously-a-factory@aviously-a-factory": [
      { scope: "user", version: "0.1.0" },
      { scope: "project", projectPath: "/other", version: "0.3.0" },
      { scope: "project", projectPath: "/p", version: "0.2.0" },
    ],
    "other@market": [{ scope: "project", projectPath: "/p", version: "9.9.9" }],
  });
  assert.equal(installedPluginVersion("/p", {}, home), "0.2.0");
  assert.equal(installedPluginVersion("/q", {}, home), "0.1.0");
});

test("the plugin that invoked the CLI wins", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plugin-"));
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "aviously-a-factory", version: "0.4.0" }),
  );
  assert.equal(installedPluginVersion("/p", { CLAUDE_PLUGIN_ROOT: root }, claudeHome({})), "0.4.0");
});

test("no install, no version", () => {
  assert.equal(installedPluginVersion("/p", {}, claudeHome({})), undefined);
  assert.equal(
    installedPluginVersion("/p", {}, mkdtempSync(join(tmpdir(), "factory-empty-"))),
    undefined,
  );
});
