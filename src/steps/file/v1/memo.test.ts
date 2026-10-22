import assert from "node:assert/strict";
import { test } from "node:test";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Exec } from "../../../runtime/exec.ts";
import {
  closable,
  type Context,
  followUps,
  type Input,
  marker,
  type Memo,
  parseInput,
  publish,
  queueOutcomes,
  section,
  shiftStart,
  withSection,
} from "./memo.ts";

const trail: PaperTrail = {
  repo: "o/paper-trail",
  timesheet: "timesheets/shifts.jsonl",
  signOffs: "sign-offs",
  memoLabel: "memo",
  suggestionBox: "suggestion-box",
};

const input = (overrides: Partial<Input> = {}): Input => ({
  mode: "unsupervised",
  summary: "2 merged",
  day: "2 merged: memo, timesheet",
  intake:
    "[#680 📋](https://github.com/o/app/issues/680), [#681 📋](https://github.com/o/app/issues/681).",
  mix: "feature 3, security 1, tooling 0; features ran out, a meeting needs them",
  merged: ["[#680 🔀](https://github.com/o/app/pull/680) memo"],
  calls: ["[#680 🔀](https://github.com/o/app/pull/680) Input is JSON, not markdown"],
  proposed: ["Memo closes from the runner too"],
  ...overrides,
});

const ctx = (shift: number, hour: number, overrides: Partial<Context> = {}): Context => ({
  now: new Date(2026, 9, 14, hour, 5),
  started: new Date(2026, 9, 14, hour, 5),
  repo: "o/app",
  shift,
  stamp: {
    person: "acharlop",
    machine: "Jarvis",
    step: "file@1",
    factory: "0.2.0",
    steps: ["file@1"],
  },
  usage: undefined,
  runDir: "/runs/2026-10-14",
  queueLog: "",
  timings: [],
  ...overrides,
});

type Issue = Memo & { state: string; labels?: string[] };

/** gh against an in-memory paper trail: issue list, create, edit, close and reopen. */
function fakeGh(issues: Issue[]) {
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const sh: Exec = (_command, args, options = {}) => {
    const [, verb] = args;
    assert.equal(flag(args, "-R"), "o/paper-trail");
    if (verb === "list") {
      const state = flag(args, "--state");
      const day = args.includes("--search") ? /"(.*)"/.exec(flag(args, "--search"))![1]! : "";
      return {
        status: 0,
        stdout: JSON.stringify(
          issues.filter(
            (issue) => (state === "all" || issue.state === state) && issue.title.includes(day),
          ),
        ),
        stderr: "",
      };
    }
    if (verb === "create") {
      const number = issues.length + 1;
      const url = `https://github.com/o/paper-trail/issues/${number}`;
      issues.push({
        number,
        url,
        state: "open",
        title: flag(args, "--title"),
        body: options.input!,
        labels: [flag(args, "--label")],
      });
      return { status: 0, stdout: `${url}\n`, stderr: "" };
    }
    const issue = issues.find((i) => i.number === Number(args[2]))!;
    if (verb === "edit")
      Object.assign(issue, { title: flag(args, "--title"), body: options.input! });
    if (verb === "close") issue.state = "closed";
    if (verb === "reopen") issue.state = "open";
    return { status: 0, stdout: "", stderr: "" };
  };
  return sh;
}

test("two shifts on one day make one memo with two sections, each carrying the marker a runner scans for", () => {
  const issues: Issue[] = [];
  const sh = fakeGh(issues);
  assert.equal(publish(input(), ctx(7, 9), trail, sh).status, 0);
  assert.equal(
    publish(input({ mode: "supervised", day: "3 merged" }), ctx(8, 14), trail, sh).status,
    0,
  );

  assert.equal(issues.length, 1);
  const [memo] = issues;
  assert.equal(memo!.title, "Factory 2026-10-14 · acharlop@jarvis · 3 merged");
  assert.deepEqual(memo!.labels, ["memo"]);
  for (const shift of [7, 8])
    assert.equal(memo!.body.split(marker(shift)).length - 1, 1, `shift ${shift} marker once`);
  assert.match(memo!.body, /^## 09:05 · unsupervised · 2 merged\n<!-- run 7 -->$/m);
  assert.match(memo!.body, /^## 14:05 · supervised · 2 merged\n<!-- run 8 -->$/m);
});

test("calls made are a plain list, proposed follow-ups are checkboxes, and the section says what filed it", () => {
  const text = section(input(), ctx(7, 9));
  assert.match(
    text,
    /### Calls made\n\n- \[#680 🔀\]\(https:\/\/github.com\/o\/app\/pull\/680\) Input is JSON/,
  );
  assert.match(text, /### Proposed follow-ups\n\n- \[ \] Memo closes from the runner too/);
  assert.match(text, /- \*\*Reds:\*\* none/);
  assert.match(text, /### Filed\n\nNone\./);
  assert.match(text, /- \*\*Intake:\*\* \[#680 .*\)\. Shift 7\./);
  assert.match(text, /\*\*Filed by\*\*: file@1, factory 0\.2\.0, steps file@1/);
});

test("a shift's section keeps the usage line but not a row per agent, so a day's memo stays under GitHub's body cap", () => {
  const use = { turns: 3, read: 1_000_000, written: 1000, peak: 50_000, start: 0, end: 600_000 };
  const agent = { ...use, id: "a", ticket: "656", step: "build", type: "temp", running: false };
  const usage = { session: "dfa6c365", foreman: use, agents: [agent], earlier: [] };
  const text = section(input(), ctx(7, 9, { usage }));
  assert.match(text, /- \*\*Usage:\*\* wall \d+ min/);
  assert.match(text, /\*\*Agent usage\*\*: in the timesheet's row for session `dfa6c365`/);
  assert.doesNotMatch(text, /^656\tbuild/m);
});

test("rerunning a shift replaces its section instead of adding a second", () => {
  const first = withSection("", 7, section(input(), ctx(7, 9)));
  const both = withSection(first, 8, section(input(), ctx(8, 14)));
  const again = withSection(both, 7, section(input({ summary: "3 merged" }), ctx(7, 9)));
  assert.equal(again.split(marker(7)).length - 1, 1);
  assert.match(again, /## 09:05 · unsupervised · 3 merged\n<!-- run 7 -->[\s\S]*<!-- run 8 -->/);
  assert.doesNotMatch(again, /09:05 · unsupervised · 2 merged/);
});

test("a ticked follow-up not yet filed on any open memo stops the publish", () => {
  const issues = [
    {
      number: 12,
      url: "https://github.com/o/paper-trail/issues/12",
      state: "open",
      title: "Factory 2026-10-13 · acharlop@jarvis · 2 merged",
      body: "## Proposed follow-ups\n\n- [x] Split the queue test\n- [ ] Leave this one",
    },
  ];
  const result = publish(input(), ctx(7, 9), trail, fakeGh(issues));
  assert.equal(result.status, 1);
  assert.match(result.said.join("\n"), /#12: Split the queue test/);
  assert.equal(issues.length, 1);
});

test("a past day's memo closes once every follow-up is filed or answered; today's and unsettled ones stay open", () => {
  const body = (boxes: string) =>
    `## Calls made\n\n- [ ] an old-style call box\n\n## Proposed follow-ups\n\n${boxes}`;
  const memo = (title: string, boxes: string): Memo => ({
    number: 1,
    url: "",
    title,
    body: body(boxes),
  });
  const settled =
    "- [x] Filed one → [#690 📋](https://github.com/o/app/issues/690)\n- [ ] Dropped → https://github.com/o/paper-trail/issues/3#issuecomment-1";
  assert.equal(closable(memo("Factory 2026-10-13 · a@b · x", settled), "2026-10-14"), true);
  assert.equal(
    closable(memo("Factory run 2026-10-13 · supervised · a@b · x", settled), "2026-10-14"),
    true,
  );
  assert.equal(closable(memo("Factory 2026-10-14 · a@b · x", settled), "2026-10-14"), false);
  assert.equal(
    closable(memo("Factory 2026-10-13 · a@b · x", "- [ ] Not answered"), "2026-10-14"),
    false,
  );
  assert.deepEqual(
    followUps(body(settled)).map(({ ticked, settled }) => [ticked, settled]),
    [
      [true, true],
      [false, true],
    ],
  );
});

test("publishing closes a settled past memo", () => {
  const issues = [
    {
      number: 1,
      url: "https://github.com/o/paper-trail/issues/1",
      state: "open",
      title: "Factory 2026-10-13 · acharlop@jarvis · 2 merged",
      body: "## Proposed follow-ups\n\n- [x] One → [#690 📋](https://github.com/o/app/issues/690)",
    },
  ];
  assert.equal(publish(input(), ctx(7, 9), trail, fakeGh(issues)).status, 0);
  assert.equal(issues[0]!.state, "closed");
  assert.equal(issues[1]!.state, "open");
});

test("the queue's outcomes count only from the shift's start, each PR linked to the project's repo", () => {
  const log = [
    "2026-10-14T09:29:00.013Z merge-queue: Landed: #673, #674. Dropped: none.",
    "2026-10-14T09:48:17.353Z merge-queue: the queue is empty.",
    "2026-10-14T09:48:17.354Z merge-queue: Landed: #675. Dropped: #680.",
  ].join("\n");
  assert.deepEqual(queueOutcomes(log, Date.parse("2026-10-14T09:40:00Z"), "o/app"), [
    "Landed: [#675 🔀](https://github.com/o/app/pull/675). Dropped: [#680 🔀](https://github.com/o/app/pull/680).",
  ]);
});

test("a follow-up is settled only when its line ends with an arrow and a link", () => {
  const settled = (line: string) =>
    followUps(`## Proposed follow-ups\n\n- [x] ${line}`)[0]!.settled;
  assert.equal(settled("Rename queue.log → queue.jsonl"), false);
  assert.equal(settled("Rename → [#690 📋](https://github.com/o/app/issues/690) later"), false);
  assert.equal(settled("Dropped → answered in a comment"), false);
  assert.equal(settled("Rename → [#690 📋](https://github.com/o/app/issues/690)"), true);
  assert.equal(settled("Dropped → https://github.com/o/paper-trail/issues/3#issuecomment-1"), true);
});

test("a shift that crosses midnight writes to the day it started", () => {
  const issues: Issue[] = [];
  publish(input(), ctx(7, 0, { started: new Date(2026, 9, 13, 23, 40) }), trail, fakeGh(issues));
  assert.equal(
    issues[0]!.title,
    "Factory 2026-10-13 · acharlop@jarvis · 2 merged: memo, timesheet",
  );
});

test("a shift starts at its open start mark, unless that mark is older than the shift's timeout", () => {
  const now = new Date("2026-10-13T22:30:00Z");
  const marks = [{ step: "run", event: "start", at: "2026-10-13T20:40:00Z" }] as const;
  assert.equal(shiftStart(marks, now, 150).toISOString(), "2026-10-13T20:40:00.000Z");
  assert.equal(
    shiftStart([...marks, { step: "run", event: "end", at: "2026-10-13T22:00:00Z" }], now, 150),
    now,
  );
  assert.equal(shiftStart(marks, now, 60), now);
});

test("today's memo closed by hand is reopened and edited, not opened a second time", () => {
  const issues = [
    {
      number: 1,
      url: "https://github.com/o/paper-trail/issues/1",
      state: "closed",
      title: "Factory 2026-10-14 · acharlop@jarvis · 2 merged",
      body: "",
    },
  ];
  assert.equal(publish(input(), ctx(7, 9), trail, fakeGh(issues)).status, 0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.state, "open");
  assert.match(issues[0]!.body, /<!-- run 7 -->/);
});

test("a dry run says what it would do and changes nothing", () => {
  const issues = [
    {
      number: 1,
      url: "https://github.com/o/paper-trail/issues/1",
      state: "open",
      title: "Factory 2026-10-13 · acharlop@jarvis · 2 merged",
      body: "## Proposed follow-ups\n\n- [x] One → [#690 📋](https://github.com/o/app/issues/690)",
    },
  ];
  const { said } = publish(input(), ctx(7, 9), trail, fakeGh(issues), true);
  assert.match(said.join("\n"), /would open shift 7 on the day's memo/);
  assert.match(said.join("\n"), /would close https:\/\/github.com\/o\/paper-trail\/issues\/1/);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.state, "open");
});

test("input without a known mode, a summary or a mix is refused; yarcone's mode names still pass", () => {
  assert.throws(() => parseInput(JSON.stringify({ ...input(), mode: "fast" })), /mode/);
  assert.throws(() => parseInput(JSON.stringify({ ...input(), summary: " " })), /summary/);
  assert.throws(() => parseInput(JSON.stringify({ ...input(), summary: "2\nmerged" })), /summary/);
  assert.throws(() => parseInput(JSON.stringify({ ...input(), day: "2\nmerged" })), /day/);
  assert.throws(() => parseInput(JSON.stringify({ ...input(), mix: undefined })), /mix/);
  assert.equal(parseInput(JSON.stringify(input())).mode, "unsupervised");
  assert.equal(parseInput(JSON.stringify(input({ mode: "autopilot" }))).mode, "autopilot");
});
