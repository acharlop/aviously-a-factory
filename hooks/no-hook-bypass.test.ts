import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { refusal } from "./no-hook-bypass.ts";

const hook = fileURLToPath(new URL("no-hook-bypass.ts", import.meta.url));
const hooksJson = fileURLToPath(new URL("hooks.json", import.meta.url));

const message =
  "fix: pre-push said no\n\nNever `git push --no-verify`; git commit -n skips it too.";

test("a git command that skips the hooks is refused, however it is written", () => {
  for (const command of [
    "git push --no-verify",
    "git push --no-verif origin topic",
    "git commit --no-verify -m 'wip'",
    "git commit -n -m wip",
    "git commit -anm wip",
    "git merge --no-verify origin/main",
    "/usr/bin/git -C /tmp/repo push --no-verify",
    "cd /repo && git add -A && git commit -qm wip --no-verify",
    "git status; git push --no-verify 2>&1 | tail",
    "FORCE_COLOR=0 git push --no-verify",
    "(cd /repo && git push --no-verify)",
    "git push \\\n  --no-verify",
    "git push --no-verif\\y",
    "git -c core.hooksPath=/dev/null push",
    "git -c core.hookspath= commit -m x",
    "git --config-env=core.hooksPath=EMPTY push",
    "git --config-env core.hooksPath=EMPTY push",
    "git config core.hooksPath /dev/null",
    "git config --local core.hooksPath ''",
    "git config set core.hooksPath /dev/null",
    "git config --unset core.hooksPath",
    "git config unset core.hooksPath",
    "git config core.hooksPath .githooks",
  ])
    assert.ok(refusal(command), command);
  assert.ok(refusal("git config core.hooksPath /dev/null", ".githooks"));
});

test("git commands that keep the hooks, and words that only mention a bypass, run", () => {
  for (const command of [
    "git push origin topic",
    "git push -n origin topic",
    "git commit -m 'Gate: refuse --no-verify'",
    "git commit -mn",
    "git commit --amend --no-edit",
    "git log --oneline -n 5",
    "git config --get core.hooksPath",
    "git config core.hooksPath",
    "git grep -n -- --no-verify",
    "rg -- '--no-verify' docs",
    "echo git push --no-verify",
    `git commit -q -F - <<'EOF'\n${message}\nEOF`,
    `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`,
    "# git push --no-verify\ngit push",
    "git commit -m 'never `git push --no-verify`'",
    'gh pr create --body "Refuses \\`git push --no-verify\\`"',
    "echo '$(git push --no-verify)'",
    "cat <<-EOF\n\tgit push --no-verify\n\tEOF\ngit push",
  ])
    assert.equal(refusal(command), undefined, command);
  assert.equal(refusal("git config core.hooksPath .githooks", ".githooks"), undefined);
});

test("an admin merge is refused; a plain or auto merge, and words that only mention one, run", () => {
  for (const command of [
    "gh pr merge 1 --admin",
    "gh pr merge 1 --squash --admin --delete-branch",
    "gh pr merge --admin=true 1",
    "cd /repo && GH_TOKEN=x gh pr merge 1 --admin",
    "gh -R x/y pr merge 1 --admin",
    "gh --repo x/y pr merge 1 --admin",
    "gh --repo=x/y pr merge 1 --admin",
  ])
    assert.match(refusal(command) ?? "", /^Refused: `gh pr merge --admin`/, command);
  for (const command of [
    "gh pr merge 1 --squash --delete-branch",
    "gh pr merge 1 --auto --squash",
    "gh pr merge 1 --admin=false",
    "gh pr view 1 --json title",
    "gh pr comment 1 --body 'never --admin'",
    "echo gh pr merge 1 --admin",
    "gh pr merge 1 --squash -- --admin",
  ])
    assert.equal(refusal(command), undefined, command);
});

function runHook(input: string) {
  return spawnSync(process.execPath, [hook], { input, encoding: "utf8" });
}

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

test("the hook exits 2 with the reason for a refused Bash command, and 0 for any other", () => {
  const refused = runHook(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --no-verify" } }),
  );
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Refused: --no-verify/);
  const allowed = runHook(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } }),
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(runHook(JSON.stringify({ tool_name: "Bash", tool_input: {} })).status, 0);
});

test("the hook lets a repo's own core.hooksPath be set again, and no other", () => {
  const repo = mkdtempSync(join(tmpdir(), "no-hook-bypass-"));
  git(repo, "init", "-q");
  git(repo, "config", "core.hooksPath", ".githooks");
  const run = (command: string) =>
    runHook(JSON.stringify({ cwd: repo, tool_name: "Bash", tool_input: { command } })).status;
  assert.equal(run("git config core.hooksPath .githooks"), 0);
  assert.equal(run("git config core.hooksPath /dev/null"), 2);
});

test("the plugin runs the hook before every Bash command", () => {
  const { hooks } = JSON.parse(readFileSync(hooksJson, "utf8")) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const commands = hooks.PreToolUse.filter((entry) => entry.matcher === "Bash").flatMap((entry) =>
    entry.hooks.map((each) => each.command),
  );
  assert.ok(
    commands.some((command) => command === 'node "${CLAUDE_PLUGIN_ROOT}/hooks/no-hook-bypass.ts"'),
  );
});
