import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { refusal } from "./link-icons.ts";

const hook = fileURLToPath(new URL("link-icons.ts", import.meta.url));
const hooksJson = fileURLToPath(new URL("hooks.json", import.meta.url));

const issue = "https://github.com/owner/project/issues/866";
const pr = "https://github.com/owner/project/pull/893";

test("a gh write that links an issue with the PR icon, or a PR with the issue icon, is refused and names the link", () => {
  for (const [command, link] of [
    [`gh pr create --title x --body "Fixes [#866 🔀](${issue})"`, `[#866 🔀](${issue})`],
    [`gh issue comment 866 --body 'Landed in [#893 📋](${pr})'`, `[#893 📋](${pr})`],
    [`gh -R owner/project issue edit 866 --body "[#866 🔀](${issue})"`, `[#866 🔀](${issue})`],
    [
      `gh pr edit 893 --body "$(cat <<'EOF'\nok [#893 🔀](${pr})\nbad [#866 🔀](${issue})\nEOF\n)"`,
      `[#866 🔀](${issue})`,
    ],
    [
      `cd /repo && gh api repos/x/y/issues/1/comments -f body='[#893 📋](${pr})'`,
      `[#893 📋](${pr})`,
    ],
    [`gh issue close 866 --comment "Done in [#893 📋](${pr})"`, `[#893 📋](${pr})`],
    [`gh pr close 893 --comment "See [#866 🔀](${issue})"`, `[#866 🔀](${issue})`],
    [`gh pr merge 893 --squash --body "Fixes [#866 🔀](${issue})"`, `[#866 🔀](${issue})`],
    [
      `pnpm factory:comment-edit issue 866 --body-file - <<'EOF'\n[#893 📋](${pr})\nEOF`,
      `[#893 📋](${pr})`,
    ],
    [`factory comment-edit pr 893 --body "[#893 📋](${pr})"`, `[#893 📋](${pr})`],
  ] as const)
    assert.ok(refusal(command)?.startsWith(`Refused: ${link} links`), command);
});

test("a body file the command names is read too", () => {
  const file = join(mkdtempSync(join(tmpdir(), "link-icons-")), "body.md");
  writeFileSync(file, `Fixes [#866 🔀](${issue})\n`);
  assert.match(refusal(`gh pr create --title x --body-file ${file}`) ?? "", /PR icon/);
  writeFileSync(file, `Fixes [#866 📋](${issue})\n`);
  assert.equal(refusal(`gh pr create --title x --body-file=${file}`), undefined);
});

test("a relative body file resolves against a leading cd, else the command's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "link-icons-"));
  writeFileSync(join(dir, "body.md"), `Fixes [#866 🔀](${issue})\n`);
  assert.match(refusal(`cd ${dir} && gh pr create --body-file body.md`, "/") ?? "", /PR icon/);
  assert.match(
    refusal(`cd .. && gh pr create --body-file body.md`, join(dir, "sub")) ?? "",
    /PR icon/,
  );
  assert.match(refusal("gh pr create --body-file ./body.md", dir) ?? "", /PR icon/);
  assert.equal(refusal("gh pr create --body-file body.md", tmpdir()), undefined);
});

test("right icons, other commands, and gh reads run", () => {
  for (const command of [
    `gh pr create --body "Fixes [#866 📋](${issue}), after [#893 🔀](${pr})"`,
    `gh issue comment 866 --body "[#866 📋](${issue}/comments)"`,
    `echo "[#866 🔀](${issue})"`,
    `git commit -m "[#866 🔀](${issue})"`,
    `gh pr view 893 --json body`,
    `gh pr list --search "[#866 🔀](${issue})"`,
  ])
    assert.equal(refusal(command), undefined, command);
});

test("the hook exits 2 with the reason for a refused command, and 0 for any other", () => {
  const run = (command: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });
  const refused = run(`gh issue comment 1 --body "[#866 🔀](${issue})"`);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Refused: \[#866 🔀\]/);
  assert.equal(run(`gh issue comment 1 --body "[#866 📋](${issue})"`).status, 0);
});

test("the plugin runs the hook before every Bash command", () => {
  const { hooks } = JSON.parse(readFileSync(hooksJson, "utf8")) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const commands = hooks.PreToolUse.filter((entry) => entry.matcher === "Bash").flatMap((entry) =>
    entry.hooks.map((each) => each.command),
  );
  assert.ok(
    commands.some((command) => command === 'node "${CLAUDE_PLUGIN_ROOT}/hooks/link-icons.ts"'),
  );
});
