import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig, resolveConfig } from "../../../config/load.ts";
import type { Exec } from "../../../runtime/exec.ts";
import { FACTORY_VERSION } from "../../../version.ts";
import { publish } from "./memo.ts";
import { type Filing, filing } from "./record.ts";
import { recorder } from "./sign-off.ts";
import { parseRows, row, saveRow } from "./timesheet.ts";

const resolved = (config: object) =>
  resolveConfig(parseConfig({ configVersion: 1, ...config }), "/p");

const paperTrail = {
  repo: "o/trail",
  timesheet: "ts/rows.jsonl",
  signOffs: "so",
  memoLabel: "note",
};

/** GitHub in memory: the project's repo and login, the paper trail's files and its issues. */
function github() {
  const files: Record<string, string> = {};
  const issues: { title: string; body: string; label: string; repo: string }[] = [];
  const ok = (stdout: unknown) => ({
    status: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
  });
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const sh: Exec = (_, args, { input } = {}) => {
    if (args[0] === "repo") return ok({ nameWithOwner: "o/app" });
    if (args[1] === "user") return ok("avi\n");
    if (args[0] === "issue" && args[1] === "list") return ok([]);
    if (args[0] === "issue" && args[1] === "create") {
      issues.push({
        title: flag(args, "--title"),
        body: input!,
        label: flag(args, "--label"),
        repo: flag(args, "-R"),
      });
      return ok(`https://github.com/o/trail/issues/${issues.length}\n`);
    }
    const path = (args[1] === "-X" ? args[3]! : args[1]!).replace(/^repos\//, "");
    if (args[1] !== "-X")
      return path in files
        ? ok({
            content: Buffer.from(files[path]!).toString("base64"),
            encoding: "base64",
            sha: "s",
          })
        : { status: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    files[path] = Buffer.from(JSON.parse(input!).content, "base64").toString();
    return ok("");
  };
  return { sh, files, issues };
}

const where = (sh: Exec) => filing(resolved({ paperTrail }), sh, "/home") as Filing;

test("file@1 files as the gh login on this machine, stamped with itself and the factory release", () => {
  const { stamp, repo, project, trail } = where(github().sh);
  assert.equal(stamp.person, "avi");
  assert.match(stamp.machine, /^[^.]+$/);
  assert.equal(stamp.step, "file@1");
  assert.equal(stamp.factory, FACTORY_VERSION);
  assert.deepEqual(stamp.steps, ["file@1"]);
  assert.deepEqual([repo, project, trail], ["o/app", "app", paperTrail]);
});

test("a project with no paper trail, or the file step off or local, files nothing and says why", () => {
  const { sh } = github();
  assert.match(filing(resolved({}), sh) as string, /paperTrail is none/);
  assert.match(
    filing(resolved({ paperTrail, steps: { file: "none" } }), sh) as string,
    /file step is none/,
  );
  assert.match(
    filing(resolved({ paperTrail, steps: { file: { local: "steps/file.ts" } } }), sh) as string,
    /file step is local \(\/p\/steps\/file.ts\)/,
  );
});

test("a timesheet row lands at the configured path with its table beside it, stamped", () => {
  const { sh, files } = github();
  const { stamp, trail } = where(sh);
  const usage = { turns: 1, read: 1, written: 1, peak: 1, start: 0, end: 60_000 };
  const shift = { session: "s1", foreman: usage, agents: [], earlier: [] };
  const facts = { merged: [], decisionNeeded: 0, recalls: 0, queueLog: "", reworkReports: [] };
  saveRow(row(shift, "", facts, stamp), trail, sh);
  const [added] = parseRows(files["o/trail/contents/ts/rows.jsonl"]!);
  assert.deepEqual(
    [added!.person, added!.machine, added!.step, added!.factory],
    [stamp.person, stamp.machine, "file@1", FACTORY_VERSION],
  );
  assert.match(files["o/trail/contents/ts/README.md"]!, /^# Timesheets/);
});

test("a memo is an issue in the paper trail under the configured label, naming who filed it and with what", () => {
  const { sh, issues } = github();
  const { stamp, trail } = where(sh);
  const input = { mode: "supervised", summary: "s", day: "d", intake: "i", mix: "m" } as const;
  const now = new Date(2026, 9, 14, 9);
  const ctx = {
    now,
    started: now,
    repo: "o/app",
    shift: 1,
    stamp,
    usage: undefined,
    runDir: undefined,
    queueLog: "",
    timings: [],
  };
  assert.equal(publish(input, ctx, trail, sh).status, 0);
  const [memo] = issues;
  assert.deepEqual([memo!.repo, memo!.label], ["o/trail", "note"]);
  assert.match(
    memo!.title,
    new RegExp(`^Factory 2026-10-14 · avi@${stamp.machine.toLowerCase()} · d$`),
  );
  assert.match(
    memo!.body,
    new RegExp(`\\*\\*Filed by\\*\\*: file@1, factory ${FACTORY_VERSION.replaceAll(".", "\\.")}`),
  );
});

test("a sign-off lands in the configured folder, a folder per day, stamped", () => {
  const { sh, files } = github();
  const { stamp, trail } = where(sh);
  const record = recorder(
    trail,
    stamp,
    new Map(),
    () => {},
    (args, input) => sh("gh", args, { input }),
  );
  record({ outcome: "passed", check: "web", sha: "abcdef01", base: "origin/main" });
  const [path] = Object.keys(files);
  assert.match(path!, /^o\/trail\/contents\/so\/\d{4}-\d{2}-\d{2}\/.+-abcdef01-web-avi\.json$/);
  const body = JSON.parse(files[path!]!);
  assert.deepEqual(
    [body.person, body.machine.name, body.step, body.factory],
    [stamp.person, stamp.machine, "file@1", FACTORY_VERSION],
  );
});
