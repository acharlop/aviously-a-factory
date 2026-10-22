import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseConfig } from "../config/load.ts";
import { changedFiles, checksFor, commandCheck, docsOnly, matches } from "./checks.ts";
import { exec, type Exec } from "./exec.ts";
import { runLogged } from "./run.ts";

const gate = (checks: object, more: object = {}) =>
  parseConfig({ configVersion: 1, gate: { checks, ...more } }).gate;

test("globs match paths, and one starting with ! excludes what it matches", () => {
  assert.ok(matches("apps/web/page.tsx", ["apps/web/**"]));
  assert.ok(matches("README.md", ["**/*.md"]));
  assert.ok(!matches("packages/i18n/README.md", ["**/*.md", "!packages/i18n/**"]));
  assert.ok(!matches("src/a.ts", ["!docs/**"]));
});

test("only a non-empty list of doc files is docs only; an unreadable one isn't", () => {
  const docs = ["docs/**", "**/*.md"];
  assert.ok(docsOnly(["docs/a.png", "README.md"], docs));
  assert.ok(!docsOnly(["README.md", "src/a.ts"], docs));
  assert.ok(!docsOnly([], docs));
  assert.ok(!docsOnly(undefined, docs));
});

test("a change needs each check its files reach: one without `when` for anything past docs, none for docs alone, all when git can't say", () => {
  const config = gate({
    checks: { run: "pnpm verify" },
    web: { run: "e2e", when: ["apps/web/**", "packages/**", "!packages/tooling/**"] },
    mobile: { run: "flows", when: ["apps/mobile/**", "packages/**", "!packages/tooling/**"] },
  });
  assert.deepEqual(checksFor(config, ["packages/tooling/a.ts"]), ["checks"]);
  assert.deepEqual(checksFor(config, ["apps/web/a.tsx"]), ["checks", "web"]);
  assert.deepEqual(checksFor(config, ["packages/i18n/en.json"]), ["checks", "web", "mobile"]);
  assert.deepEqual(checksFor(config, ["docs/x.md"]), []);
  assert.deepEqual(checksFor(config, undefined), ["checks", "web", "mobile"]);
});

test("the gate's config defaults: base main, signoff/ statuses, docs and markdown as docs, a check run once under TIMEOUT_VERIFY", () => {
  const config = gate({ web: { run: "e2e", select: "node select.ts" } });
  assert.deepEqual(config, {
    base: "main",
    checks: { web: { run: "e2e", select: "node select.ts", timeout: "TIMEOUT_VERIFY", tries: 1 } },
    docs: ["docs/**", "**/*.md"],
    status: "signoff/",
  });
  assert.deepEqual(parseConfig({ configVersion: 1 }).gate.checks, {});
});

test("a check names a command or a module that supplies one, and nothing else", () => {
  assert.throws(() => gate({ web: { module: "nope" } }), /no module by that name supplies a check/);
  assert.throws(() => gate({ web: { run: "x", flows: true } }));
  assert.throws(() => gate({ Web: { run: "x" } }), /Invalid key/);
  assert.throws(() => gate({ web: { run: "x", timeout: "TIMEOUT_SOON" } }));
});

/** A repo whose main has one commit and whose topic branch adds files. */
function repo(...files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "factory-checks-"));
  const git = (...args: string[]) => exec("git", args, { cwd: dir }).stdout.trim();
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(dir, "readme.md"), "hi\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "first");
  git("checkout", "--quiet", "-b", "topic");
  for (const file of files) writeFileSync(join(dir, file), `${file}\n`);
  git("add", "-A");
  git("commit", "--quiet", "-m", "topic");
  return { dir, git };
}

test("the files a range changes, or this checkout since a base with untracked ones, or none when git can't say", () => {
  const { dir } = repo("a.ts");
  assert.deepEqual(changedFiles("main", "topic", exec, dir), ["a.ts"]);
  writeFileSync(join(dir, "b.ts"), "b\n");
  assert.deepEqual(changedFiles("main", undefined, exec, dir), ["a.ts", "b.ts"]);
  assert.equal(changedFiles("gone", "topic", exec, dir), undefined);
});

const timing = { timeout: "TIMEOUT_E2E", tries: 2 } as const;

test("a command check's select, run in the change's checkout with the base, picks its units; none printed is no run, and a failing select refuses", async () => {
  const { dir, git } = repo("a.ts");
  const base = git("rev-parse", "main");
  const change = { dir, base, head: git("rev-parse", "HEAD"), files: ["a.ts"] };
  const check = (select: string, when?: string[]) =>
    commandCheck("web", { run: "e2e", select, ...(when && { when }), ...timing }, exec);
  assert.deepEqual(await check("printf '%s\\n' $(ls *.ts)").needs(change), {
    units: ["a.ts", base],
  });
  assert.equal(await check("true").needs(change), undefined);
  assert.equal(await check("echo x", ["apps/**"]).needs(change), undefined);
  assert.deepEqual(await check("echo nope >&2; false").needs(change), {
    refused: "selecting what web runs failed: nope",
  });
  const whole = commandCheck("checks", { run: "pnpm verify", ...timing }, exec);
  assert.deepEqual(await whole.needs(change), { units: [] });
  assert.equal(whole.marker, true);
  assert.equal(check("x").marker, false);
});

test("a command check runs its command with the units as arguments: the units fail together, or the check by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-check-run-"));
  const logFile = join(dir, "run.log");
  const lines: string[] = [];
  const at = (units: string[]) => ({
    dir,
    base: "b",
    sha: "s",
    units,
    attempt: 0,
    logFile,
    timeoutMs: 60_000,
    run: (command: readonly string[], file: string, cwd?: string, ms?: number) =>
      runLogged(command, file, cwd, undefined, ms),
    log: (line: string) => lines.push(line),
  });
  const echo = commandCheck("web", { run: "echo ran", ...timing }, exec);
  assert.deepEqual(await echo.run(at(["a.spec.ts", "b c.spec.ts"])), { failed: [] });
  assert.equal(readFileSync(logFile, "utf8"), "ran a.spec.ts b c.spec.ts\n");
  const red = commandCheck("web", { run: "exit 1", ...timing }, exec);
  assert.deepEqual(await red.run(at(["a.spec.ts"])), { failed: ["a.spec.ts"] });
  assert.deepEqual(await red.run(at([])), { failed: ["web"] });
  const slow = commandCheck("web", { run: "sleep 5", ...timing }, exec);
  assert.deepEqual(await slow.run({ ...at([]), timeoutMs: 100 }), { failed: ["web"] });
  assert.match(
    lines.join("\n"),
    /^`sleep 5` ran past TIMEOUT_E2E \(.+ min\); counting it as failed$/,
  );
});

test("a select runs through sh in the change's checkout, the base its one argument", async () => {
  const seen: string[][] = [];
  const sh: Exec = (command, args) => {
    seen.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  await commandCheck("web", { run: "e2e", select: "node select.ts", ...timing }, sh).needs({
    dir: "/d",
    base: "abc",
    head: "def",
    files: undefined,
  });
  assert.deepEqual(seen, [["sh", "-c", 'node select.ts "$@"', "sh", "abc"]]);
});
