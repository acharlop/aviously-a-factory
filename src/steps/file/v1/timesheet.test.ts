import assert from "node:assert/strict";
import { test } from "node:test";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Exec } from "../../../runtime/exec.ts";
import type { Shift } from "../../../runtime/transcripts.ts";
import { localDate, type Stamp } from "./record.ts";
import {
  queueStats,
  readTimesheet,
  reviewBugs,
  type Row,
  row,
  saveRow,
  type ShiftFacts,
  shiftSearches,
  summary,
  table,
  upsert,
} from "./timesheet.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 14, 9, minute)).toISOString();
const start = Date.parse(at(0));

const usage = (from: number, to: number, read = 1000) => ({
  turns: 1,
  read,
  written: 10,
  peak: read,
  start: Date.parse(at(from)),
  end: Date.parse(at(to)),
});

const agent = (id: string, ticket: string, step: string) => ({
  id,
  ticket,
  step,
  type: "temp",
  running: false,
  ...usage(1, 5),
});

const shift: Shift = {
  session: "s1",
  foreman: { ...usage(0, 59, 5000), peak: 150_000 },
  agents: [
    agent("a", "10", "build"),
    agent("b", "10", "rework"),
    agent("c", "11", "build"),
    agent("d", "12", "build"),
  ],
  earlier: [],
  cost: { read: 9000, written: 100, thinking: 5, usd: 1.5 },
};

const queueLog = [
  "merge-queue: #9 merged",
  `${at(1)} merge-queue: test branch aaa is main bbb plus #20, #21`,
  `${at(2)} merge-queue: orders.spec.ts › a failed; rerunning orders.spec.ts once`,
  `${at(3)} merge-queue: green on retry; a test that flaked in an earlier run too goes on the flake ticket`,
  `${at(4)} merge-queue: #20 merged`,
  `${at(5)} merge-queue: test branch ccc is main ddd plus #22`,
  `${at(6)} merge-queue: \`pnpm verify\` passed on ccc`,
  `${at(7)} merge-queue: #22 merged`,
  `${at(7)} merge-queue: #28 merged outside this run`,
  `${at(8)} merge-queue: test branch eee is main fff plus #23`,
  `${at(9)} merge-queue: dropping #23: e2e failed twice on main plus this pull request`,
  `${at(10)} merge-queue: test branch iii is main jjj plus #25, #26`,
  `${at(11)} merge-queue: e2e passed on iii`,
  `${at(11)} merge-queue: dropping #26: it conflicts with main`,
  `${at(12)} merge-queue: #25 merged`,
  `${at(13)} merge-queue: test branch kkk is main lll plus #27`,
  `${at(14)} merge-queue: #27's branch moved before the push; starting over`,
  `${at(80)} merge-queue: test branch ggg is main hhh plus #24`,
].join("\n");

const stamp: Stamp = {
  person: "avi",
  machine: "jarvis",
  step: "file@1",
  factory: "0.2.0",
  steps: ["file@1"],
};

const trail: PaperTrail = {
  repo: "o/paper-trail",
  timesheet: "timesheets/shifts.jsonl",
  signOffs: "sign-offs",
  memoLabel: "memo",
};

test("the queue counts test branches in the window, flakes, drops and every PR it landed; green first try only when a branch landed all its PRs", () => {
  const stats = queueStats(queueLog, start, Date.parse(at(59)));
  assert.deepEqual(
    { ...stats, landed: [...stats.landed] },
    { batches: 5, greenFirstTry: 1, flakes: 1, drops: 2, landed: [9, 20, 22, 25] },
  );
});

test("review bugs are the items under the rework report's heading, none without it", () => {
  const report = [
    "Branch web/10-x, commits abc.",
    "",
    "**Bugs fixed from review:**",
    "- the row counted closed PRs",
    "  across two lines",
    "- the table dropped recalls",
    "",
    "Checks: pnpm verify passed.",
    "- not a bug",
  ].join("\n");
  assert.equal(reviewBugs(report), 2);
  assert.equal(reviewBugs("Bugs fixed from review: none\n\n- pnpm verify passed"), 0);
  assert.equal(reviewBugs("Fixed two findings."), 0);
});

const facts: ShiftFacts = {
  merged: [
    { number: 20, headRefName: "web/10-timesheet", mergedAt: at(4) },
    { number: 21, headRefName: "web/11-report", mergedAt: at(4) },
    { number: 30, headRefName: "web/99-other", mergedAt: at(5) },
  ],
  decisionNeeded: 1,
  recalls: 2,
  queueLog,
  reworkReports: ["Bugs fixed from review:\n- one\n- two"],
};

const foreman = JSON.stringify({
  type: "user",
  message: {
    content: "<command-name>/factory</command-name>\n<command-args>unsupervised</command-args>",
  },
});

test("a shift's row is stamped, and puts speed, cost-state tokens and each agent's usage beside rework, review bugs, the queue, hand merges and recalls", () => {
  assert.deepEqual(row(shift, foreman, facts, stamp), {
    ...stamp,
    session: "s1",
    date: localDate(new Date(start)),
    start: at(0),
    end: at(59),
    mode: "unsupervised",
    ticketsIn: 3,
    merged: 2,
    wallMinutes: 59,
    costState: { read: 9000, written: 100, thinking: 5, usd: 1.5 },
    transcripts: { leadRead: 5000, agentsRead: 4000, leadPeak: 150_000 },
    agents: [
      ["10", "build"],
      ["10", "rework"],
      ["11", "build"],
      ["12", "build"],
    ].map(([ticket, step]) => ({
      ticket,
      step,
      minutes: 4,
      turns: 1,
      read: 1000,
      written: 10,
      peak: 1000,
    })),
    mergedNoFixRound: 1,
    fixRounds: 1,
    reviewBugs: 2,
    queueGreenFirstTry: 1,
    queueBatches: 5,
    flakes: 1,
    drops: 2,
    decisionNeeded: 1,
    handMerges: 1,
    escapes: 2,
  });
  assert.equal(row(shift, "", facts, stamp).mode, "supervised");
});

test("a rerun replaces its session's row; the table shows the newest first", () => {
  const first = row(shift, foreman, facts, stamp);
  const older = { ...first, session: "s0", start: at(-60 * 24), date: "2026-10-13" };
  const rows = upsert(upsert([older, first], { ...first, merged: 3 }), first);
  assert.deepEqual(
    rows.map((r) => r.session),
    ["s0", "s1"],
  );
  const lines = table(rows, "shifts.jsonl").split("\n");
  const today = lines.find((l) => l.startsWith("| 2026-10-14"))!;
  assert.match(today, /^\| 2026-10-14 \| avi@jarvis \| unsupervised \|/);
  assert.match(today, /\| 1\/5 \| 1 \| 2 \| 1 \| 1 \| 2 \|$/);
  assert.ok(lines.indexOf(today) < lines.indexOf(lines.find((l) => l.startsWith("| 2026-10-13"))!));
});

test("a row filed before rows were stamped shows its old who, and one without cost-state shows n/a", () => {
  const { person: _, ...unstamped } = { ...row(shift, foreman, facts, stamp), costState: null };
  const line = table([{ ...unstamped, machine: "acharlop@Jarvis" }], "runs.jsonl")
    .split("\n")
    .find((l) => l.startsWith("| 2026-10-14"))!;
  assert.match(line, /^\| 2026-10-14 \| acharlop@Jarvis \|/);
  assert.match(line, /\| n\/a \| n\/a \|/);
});

test("recalls count from the previous shift's end to this shift's end; decision needed reads every issue touched in the shift", () => {
  assert.deepEqual(shiftSearches("o/r", shift, at(-30)), {
    merged: "repo:o/r is:pr is:merged merged:>=2026-10-14T09:00:00+00:00",
    labeled: "repo:o/r is:issue updated:>=2026-10-14T09:00:00+00:00",
    recalls: "repo:o/r label:recall created:2026-10-14T08:30:00+00:00..2026-10-14T09:59:00+00:00",
  });
  assert.match(
    shiftSearches("o/r", shift, undefined).recalls,
    /created:2026-10-14T09:00:00\+00:00\.\.2026-10-14T09:59:00\+00:00$/,
  );
});

const base64 = (text: string) => Buffer.from(text).toString("base64");
const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });

/** A paper trail repo in memory: GET reads a file, PUT writes it unless `conflicts` names its path, once. */
function paperTrailRepo(files: Record<string, string>, conflicts: string[] = []) {
  const puts: string[] = [];
  const prefix = `repos/${trail.repo}/contents/`;
  const sh: Exec = (_, args, options) => {
    if (args[1] !== "-X") {
      const path = args.at(-1)!.replace(prefix, "");
      if (!(path in files)) return { status: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      return ok({
        content: base64(files[path]!),
        encoding: "base64",
        sha: `sha-${files[path]!.length}`,
      });
    }
    const put = args[3]!.replace(prefix, "");
    puts.push(put);
    const conflict = conflicts.indexOf(put);
    if (conflict >= 0) {
      conflicts.splice(conflict, 1);
      files[put] = files[put] + JSON.stringify({ ...timesheetRow, session: "other" }) + "\n";
      return { status: 1, stdout: "", stderr: "gh: is at abc but expected def (HTTP 409)" };
    }
    const { content } = JSON.parse(options!.input!) as { content: string };
    files[put] = Buffer.from(content, "base64").toString("utf8");
    return ok({});
  };
  return { sh, puts };
}

const timesheetRow = row(shift, foreman, facts, stamp);

test("a 409 on a write reads the timesheet again and keeps the row another machine added", () => {
  const files: Record<string, string> = { "timesheets/shifts.jsonl": "" };
  const { sh, puts } = paperTrailRepo(files, ["timesheets/shifts.jsonl"]);
  saveRow(timesheetRow, trail, sh);
  assert.deepEqual(puts, [
    "timesheets/shifts.jsonl",
    "timesheets/shifts.jsonl",
    "timesheets/README.md",
  ]);
  assert.deepEqual(
    readTimesheet(trail, sh).map((r) => r.session),
    ["other", "s1"],
  );
  assert.match(files["timesheets/README.md"]!, /^# Timesheets\n[^]*The data is `shifts\.jsonl`/);
});

test("a timesheet over 1 MB is read through the blob API, never taken as empty", () => {
  const text = JSON.stringify(timesheetRow) + "\n";
  const sh: Exec = (_, args) =>
    args[1]!.includes("/git/blobs/sha-big")
      ? ok({ content: base64(text), encoding: "base64" })
      : ok({ content: "", encoding: "none", sha: "sha-big" });
  assert.deepEqual(readTimesheet(trail, sh), [timesheetRow]);
  const broken: Exec = () => ok({ content: "", encoding: "none", sha: "x" });
  assert.throws(() => readTimesheet(trail, broken), /came back as none/);
});

const recent: Row = {
  ...timesheetRow,
  costState: { read: 9_000_000, written: 100, thinking: 5, usd: 1.5 },
};

test("the report sums the rows started in the last days", () => {
  const old: Row = { ...recent, session: "s0", start: "2026-09-01T00:00:00.000Z" };
  const printed = summary([old, recent], 7, Date.parse(at(60)));
  assert.match(printed, /^# last 7 days: 1 shift$/m);
  assert.match(printed, /9\.0M read \(cost-state\), 4\.5M per merge\t\$1\.50/);
  assert.match(printed, /merged with no rework 1\/2\trework 1\treview bugs 2/);
  assert.match(printed, /green first try 1\/5\tflakes 1\tdrops 2/);
  assert.match(printed, /decision needed 1\thand merges 1\trecalls 2/);
});

test("shifts without cost-state show n/a, not zero tokens and $0.00", () => {
  const bare: Row = { ...recent, session: "s2", costState: null };
  assert.match(summary([bare], 7, Date.parse(at(60))), /^tokens\tn\/a \(no cost-state\)$/m);
  assert.match(
    summary([recent, bare], 7, Date.parse(at(60))),
    /9\.0M read \(cost-state\), 4\.5M per merge\t\$1\.50\t1 shift n\/a/,
  );
  assert.match(summary([recent, bare, bare], 7, Date.parse(at(60))), /\t2 shifts n\/a/);
});
