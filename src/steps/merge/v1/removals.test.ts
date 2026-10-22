import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { exec, type Exec } from "../../../runtime/exec.ts";
import { dropComment } from "./checkout.ts";
import { pr } from "./queue.fixture.ts";
import { removalPreview, removalRefusal, removals, removedScripts } from "./removals.ts";

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "app", scripts });

const guard = {
  files: [
    ".claude/skills/**",
    ".claude/agents/**",
    "tools/**",
    ".githooks/**",
    ".github/workflows/**",
  ],
  scripts: true,
  label: "removal-ok",
};

test("a script the head's root package.json no longer has is removed; an added or changed one isn't", () => {
  assert.deepEqual(
    removedScripts(
      pkg({ signoff: "a", verify: "b", dev: "c" }),
      pkg({ verify: "b2", dev: "c", lint: "d" }),
    ),
    ["signoff"],
  );
  assert.deepEqual(removedScripts("not json", pkg({})), []);
});

test("the queue reads what a head deletes or renames out of the guarded files since it forked from main", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-removals-"));
  const git = (...args: string[]) => {
    const result = exec("git", args, { cwd: dir });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "-b", "main");
  git("config", "diff.renames", "false");
  write({
    "package.json": pkg({ signoff: "a", verify: "b" }),
    ".claude/skills/factory/SKILL.md": "skill\n",
    ".claude/agents/temp.md": "temp\n",
    ".claude/agents/inspector.md": "inspector\n",
    "tools/old.ts": "old\n",
    ".githooks/pre-push": "gate\n",
    ".github/workflows/ci.yml": "ci\n",
    "apps/web/a.ts": "a\n",
  });
  commit("init");
  git("checkout", "--quiet", "-b", "topic");
  write({ "package.json": pkg({ verify: "b" }) });
  rmSync(join(dir, ".claude/skills/factory/SKILL.md"));
  rmSync(join(dir, "apps/web/a.ts"));
  rmSync(join(dir, ".githooks/pre-push"));
  rmSync(join(dir, ".github/workflows/ci.yml"));
  renameSync(join(dir, "tools/old.ts"), join(dir, "tools/new.ts"));
  mkdirSync(join(dir, "docs"));
  renameSync(join(dir, ".claude/agents/inspector.md"), join(dir, "docs/inspector.md"));
  const head = commit("removes");
  git("checkout", "--quiet", "main");
  rmSync(join(dir, ".claude/agents/temp.md"));
  const main = commit("main deletes its own file");

  assert.deepEqual(removals(exec, dir, head, main, guard), {
    scripts: ["signoff"],
    files: [
      ".claude/skills/factory/SKILL.md",
      ".githooks/pre-push",
      ".github/workflows/ci.yml",
      ".claude/agents/inspector.md",
    ],
    label: "removal-ok",
  });
  const off = { files: [], scripts: false, label: "ok" };
  assert.deepEqual(removals(exec, dir, head, main, off), { scripts: [], files: [], label: "ok" });
});

test("a git call that fails stops the removal check instead of reading as nothing removed", () => {
  for (const failing of ["merge-base", "diff", "show"]) {
    const sh: Exec = (_command, args) =>
      args[0] === failing
        ? { status: 128, stdout: "", stderr: "fatal: bad object" }
        : { status: 0, stdout: args[0] === "show" ? pkg({}) : "", stderr: "" };
    assert.throws(
      () => removals(sh, "/repo", "head", "main", guard),
      /checking removals: git/,
      failing,
    );
  }
});

test("the label lets a removal through, and nothing removed needs no label", () => {
  const removes = { scripts: ["signoff"], files: ["tools/signoff.ts"], label: "removal-ok" };
  assert.match(
    dropComment(removalRefusal(pr(1), removes)!, "logs"),
    /^Merge queue dropped this: it removes a root script and a guarded file, which needs a ticket line that asks for it\. To land it, the foreman adds the `removal-ok` label once quality control explains it, and turns auto-merge back on\.\n/,
  );
  assert.equal(removalRefusal(pr(1, { labels: ["removal-ok"] }), removes), undefined);
  assert.equal(removalRefusal(pr(1), { ...removes, scripts: [], files: [] }), undefined);
});

test("the dry run names each removal the guard would drop a pull request for", () => {
  const removes = { scripts: ["signoff"], files: ["tools/signoff.ts"], label: "removal-ok" };
  assert.equal(
    removalPreview(pr(1), removes),
    "would be dropped: it removes a root script and a guarded file, which needs a ticket line that asks for it (removed script: signoff; deleted: tools/signoff.ts)",
  );
  assert.equal(removalPreview(pr(1), { ...removes, scripts: [], files: [] }), undefined);
});
