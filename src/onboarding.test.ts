import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseConfig } from "./config/load.ts";
import { FACTORY_LABELS } from "./labels.ts";
import { configText, detect, KNOWN_BOTS, planLines, starterConfig } from "./onboarding.ts";
import type { Exec } from "./runtime/exec.ts";

/** A pnpm and turbo monorepo with two apps, one of them Expo, Actions CI and Greptile. */
function project(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-onboard-"));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ packageManager: "pnpm@11.4.0" }),
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml": "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n",
    "turbo.json": "{}",
    "apps/website/package.json": "{}",
    "apps/mobile/package.json": JSON.stringify({ dependencies: { expo: "55.0.0" } }),
    "apps/Notes/package.json": "{}",
    ".github/workflows/ci.yml": "",
    "greptile.json": "{}",
    "AGENTS.md": "# Handbook\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });

function github({ required = ["Quality gate"], autoMerge = false, squash = true } = {}) {
  const asked: string[] = [];
  const sh: Exec = (command, args) => {
    asked.push(`${command} ${args.join(" ")}`);
    if (args[0] === "repo")
      return ok({ nameWithOwner: "o/app", defaultBranchRef: { name: "main" } });
    if (args[1] === "repos/o/app")
      return ok({
        allow_squash_merge: squash,
        allow_rebase_merge: true,
        allow_auto_merge: autoMerge,
      });
    if (args[1]?.includes("/rules/branches/"))
      return ok([
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: required.map((context) => ({ context })),
          },
        },
      ]);
    return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
  };
  return { sh, asked };
}

test("a monorepo with required checks and Actions CI starts on merge@2 with no gate, its apps as departments, and its review bots", () => {
  const facts = detect(project(), github().sh);
  assert.deepEqual(facts.apps, ["mobile", "website"]);
  assert.deepEqual(facts.expo, ["mobile"]);
  const config = starterConfig(facts);
  assert.deepEqual(config.steps, { gate: "none", merge: 2 });
  assert.deepEqual(config.departments, ["mobile", "website"]);
  assert.deepEqual(config.modules, {
    reviewBots: { bots: { greptile: KNOWN_BOTS.greptile!.bot } },
  });
  assert.equal(config.merge, undefined);
  const parsed = parseConfig(config);
  assert.equal(
    parsed.modules.reviewBots !== "none" && parsed.modules.reviewBots.bots.greptile?.pass,
    "^[45]$",
  );
});

test("without required checks it stays on merge@1, and a repo that can't squash gets its merge method", () => {
  const facts = detect(project(), github({ required: [], squash: false }).sh);
  const config = starterConfig(facts);
  assert.equal(config.steps, undefined);
  assert.deepEqual(config.merge, { method: "rebase" });
});

test("the starter config is a factory.config.ts a project can load", () => {
  const text = configText({ configVersion: 1, departments: ["web"], steps: { merge: 2 } });
  assert.match(text, /^import \{ defineConfig \} from "aviously-a-factory";\n/);
  assert.match(text, /\n {2}configVersion: 1,\n {2}departments: \[/);
  assert.match(text, /steps: \{\n {4}merge: 2\n {2}\}/);
});

test("the plan renames the factory's labels, creates its own and the departments', and leaves the rest alone; it lists the handbook and what a person does", () => {
  const facts = detect(project(), github().sh);
  const labels = [
    ...FACTORY_LABELS.filter(({ name }) => !["decision needed", "Parked"].includes(name)),
    { name: "needs-decision", color: "fbca04", description: "Needs a decision" },
    { name: "backlog", color: "ededed", description: "Parked, not scheduled" },
    { name: "wayfinder:map", color: "1D76DB", description: "A map" },
    { name: "mobile", color: "1d76db", description: "apps/mobile" },
  ];
  const lines = planLines(
    facts,
    { text: "", written: false, labelRenames: { backlog: "Parked" }, departments: ["mobile"] },
    labels,
  ).join("\n");
  assert.match(lines, /rename needs-decision to decision needed/);
  assert.match(lines, /rename backlog to Parked/);
  assert.match(lines, /create department:mobile/);
  assert.match(lines, /left alone: wayfinder:map, mobile\n/);
  assert.match(lines, /have AGENTS\.md\n {2}missing CLAUDE\.md\n {2}missing docs\/agents/);
  assert.match(lines, /under allowBuilds in pnpm-workspace\.yaml/);
  assert.match(lines, /turn on "Allow auto-merge" in o\/app's settings/);
  assert.match(lines, /apps\/mobile is an Expo app/);
  assert.doesNotMatch(lines, /write AGENTS\.md/);
});

test("onboarding only reads GitHub", () => {
  const { sh, asked } = github();
  detect(project(), sh);
  assert.ok(
    asked.every((call) => /^gh (repo view|api repos\/)/.test(call)),
    asked.join("\n"),
  );
  assert.ok(asked.every((call) => !call.includes("--method")));
});
