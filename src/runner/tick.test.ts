import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { readState, shiftCount } from "../runtime/machine.ts";
import type { Job, Outcome } from "./child.ts";
import { memoNews, numbers, parseSignature, tick, triageDue, waiting } from "./tick.ts";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const TRAIL = { repo: "o/trail", memoLabel: "memo" };

type Fake = {
  machine?: string;
  projects?: Record<string, string>;
  free?: (project: string, args: string[]) => string;
  inFlight?: (project: string) => string;
  untriaged?: string;
  memos?: { number: number; title: string; body: string }[];
  memoIds?: string;
  outcome?: Outcome;
  freeFails?: boolean;
};

function machine(fake: Fake = {}) {
  const home = mkdtempSync(join(tmpdir(), "factory-runner-"));
  writeFileSync(join(home, "machine"), fake.machine ?? "PROJECTS=a\n");
  writeFileSync(join(home, "claude-token"), "token");
  chmodSync(join(home, "claude-token"), 0o600);
  const checkouts: Record<string, string> = {};
  for (const [name, config] of Object.entries(fake.projects ?? { a: "" })) {
    checkouts[name] = join(home, "code", name);
    mkdirSync(checkouts[name], { recursive: true });
    mkdirSync(join(home, name), { recursive: true });
    writeFileSync(join(home, name, "config"), `CHECKOUT=${checkouts[name]}\n${config}`);
  }
  const projectAt = (cwd = "") =>
    Object.entries(checkouts).find(([, dir]) => dir === cwd)?.[0] ?? "?";
  const calls: string[] = [];
  const jobs: Job[] = [];
  const logLines: string[] = [];
  let off = 0;
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const sh: Exec = (command, args, options = {}) => {
    const project = projectAt(options.cwd);
    calls.push(`${project}: ${command} ${args.join(" ")}`);
    if (command === "git") return args[0] === "symbolic-ref" ? ok("main\n") : ok();
    if (command === "pnpm" && args[0] === "--silent") {
      const [, , what, ...rest] = args;
      if (what === "resolve")
        return ok(
          JSON.stringify({
            paperTrail: TRAIL,
            steps: { "performance-review": { version: 1, summary: "" } },
          }),
        );
      if (what === "in-flight") return ok(fake.inFlight?.(project) ?? "");
      if (what === "free" && fake.freeFails)
        return { status: 1, stdout: "", stderr: "gh: Bad credentials\n" };
      if (what === "free") return ok(`# order: priority\n${fake.free?.(project, rest) ?? ""}`);
      if (what === "untriaged") return ok(fake.untriaged ?? "");
      if (what === "review-due") return ok("not due: 2 h ago\n");
      return ok();
    }
    if (command === "gh" && args[0] === "issue" && args[1] === "list")
      return args.includes("number,title,body")
        ? ok(JSON.stringify(fake.memos ?? []))
        : ok(fake.memoIds ?? "");
    if (command === "gh" && args[0] === "issue" && args[1] === "view")
      return ok(JSON.stringify({ state: "OPEN", comments: [{}], body: "" }));
    if (command === "gh" && args[0] === "pr") return ok("");
    return ok();
  };
  const printed: string[] = [];
  const runner = (dry = false) => ({
    home,
    sh,
    run: async (job: Job) => {
      jobs.push(job);
      return (
        fake.outcome ?? {
          exit: 0,
          summary: { session: "s1", agents: 1, tokens: 5, turns: 2, costUsd: 0 },
        }
      );
    },
    now: () => NOW,
    dry,
    print: (line: string) => printed.push(line),
    pid: process.pid,
    alive: () => true,
    who: () => "avi@jarvis",
    turnOff: () => off++,
    user: "/Users/j",
  });
  const log = () => {
    const file = join(home, "runner", "runner.log");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").concat(logLines) : [];
  };
  return { home, calls, jobs, printed, runner, log, offs: () => off };
}

test("ticket lines and the in-flight tickets that wait on a person", () => {
  assert.deepEqual(numbers("# order: priority\n12\tfeature\tA\n9\tbug\tB\n"), [12, 9]);
  const inFlight = "4\tA\tweb/4-a\tmerge\n5\tB\tweb/5-b\twaits: auto-merge is off\n";
  assert.deepEqual(waiting(inFlight), [5]);
});

test("a memo has news on a new comment, a changed box, or a close with boxes unticked", () => {
  const seen = parseSignature("OPEN 1 -xo")!;
  assert.equal(memoNews(3, { state: "OPEN", comments: 1, boxes: "xo" }, seen), undefined);
  assert.match(memoNews(3, { state: "OPEN", comments: 2, boxes: "xo" }, seen)!, /1 new comment/);
  assert.match(memoNews(3, { state: "OPEN", comments: 1, boxes: "xx" }, seen)!, /boxes changed/);
  assert.match(
    memoNews(3, { state: "CLOSED", comments: 1, boxes: "xo" }, seen)!,
    /closed with unticked/,
  );
  assert.equal(memoNews(4, { state: "OPEN", comments: 0, boxes: "oo" }, undefined), undefined);
  assert.match(
    memoNews(4, { state: "OPEN", comments: 0, boxes: "xo" }, undefined)!,
    /boxes changed/,
  );
});

test("triage repeats for a new untriaged set, or the same one after 6 hours", () => {
  const at = NOW / 1000;
  assert.equal(triageDue("s", {}, NOW), true);
  assert.equal(triageDue("s", { TRIAGED_SET: "s", TRIAGED_AT: String(at - 3600) }, NOW), false);
  assert.equal(triageDue("s", { TRIAGED_SET: "s", TRIAGED_AT: String(at - 7 * 3600) }, NOW), true);
  assert.equal(triageDue("t", { TRIAGED_SET: "s", TRIAGED_AT: String(at) }, NOW), true);
});

test("with no rota, an empty shift is skipped and nothing calls Claude", async () => {
  const m = machine();
  assert.equal(await tick(m.runner()), 0);
  assert.equal(m.jobs.length, 0);
  assert.ok(m.calls.includes("a: pnpm --silent factory free --order priority"));
  assert.match(m.log().at(-1)!, /idle$/);
  assert.equal(existsSync(join(m.home, "runner", "lock")), false);
});

test("a shift with free tickets runs the foreman lights-out, after the runner bumps its count", async () => {
  const m = machine({
    free: () => "12\tfeature\tA\n",
    memos: [{ number: 5, title: "Factory 2026-10-22 · avi@jarvis · day", body: "<!-- run 1 -->" }],
  });
  await tick(m.runner());
  assert.equal(m.jobs.length, 1);
  const [job] = m.jobs;
  assert.equal(job!.args[1], "/aviously-a-factory:foreman lights-out order:priority");
  assert.equal(job!.cwd, join(m.home, "code", "a"));
  assert.equal(job!.capMinutes, 150);
  assert.equal(job!.env!.CLAUDE_CODE_OAUTH_TOKEN, "token");
  assert.match(job!.env!.FACTORY_RUN_DIR!, /a\/runs\/\d{4}-\d{2}-\d{2}$/);
  assert.match(job!.prefix, /a\/runs\/\d{4}-\d{2}-\d{2}\/\d{6}-shift-1\/claude$/);
  assert.equal(shiftCount("a", m.home), 1);
  assert.match(m.log().at(-1)!, /shift 1 on a \(default\) \(free: #12\): exit 0, .*memo #5/);
  assert.ok(!m.calls.some((call) => call.includes("factory memo")));
});

test("the rota walks past an empty shift to the next project with work for the next one", async () => {
  const m = machine({
    machine:
      'PROJECTS="a b"\nROTA="features debt"\nSHIFT_FEATURES="kind:feature merged:2"\nSHIFT_DEBT="kind:debt minutes:60"\n',
    projects: { a: "", b: "" },
    free: (project, args) => (project === "b" && args.includes("debt") ? "7\tdebt\tD\n" : ""),
  });
  await tick(m.runner());
  assert.equal(
    m.jobs[0]!.args[1],
    "/aviously-a-factory:foreman lights-out kind:debt order:priority minutes:60",
  );
  assert.equal(m.jobs[0]!.capMinutes, 60);
  assert.deepEqual(readState(join(m.home, "runner", "state")), { ROTA_AT: "1", ROTA_DONE: "b" });
});

test("a tickets in flight here resumes, but not one waiting on a person", async () => {
  const waits = machine({ inFlight: () => "4\tA\tweb/4-a\twaits: auto-merge is off\n" });
  await tick(waits.runner());
  assert.equal(waits.jobs.length, 0);
  const moves = machine({ inFlight: () => "4\tA\tweb/4-a\trework\n" });
  await tick(moves.runner());
  assert.equal(moves.jobs.length, 1);
});

test("a shift stopped by the usage limit files a memo saying so, and the machine takes a lunch break", async () => {
  const limit = NOW / 1000 + 3600;
  const m = machine({
    free: () => "12\tfeature\tA\n",
    outcome: {
      exit: 1,
      summary: { session: "s9", agents: 0, tokens: 9, turns: 1, costUsd: 0, limitResetsAt: limit },
    },
  });
  await tick(m.runner());
  const state = readState(join(m.home, "runner", "state"));
  assert.equal(state.LUNCH_UNTIL, String(limit));
  assert.equal(state.LUNCH_WHY, "usage limit");
  assert.ok(m.calls.includes("a: pnpm --silent factory timesheet s9"));
  const memo = m.calls.find((call) => call.includes("factory memo"))!;
  const input = JSON.parse(readFileSync(memo.split(" ")[5]!, "utf8"));
  assert.match(input.summary, /^died, no memo: hit the usage limit/);
  assert.match(m.log().at(-1)!, /died, memo filed, timesheet filed/);

  await tick(m.runner());
  assert.equal(m.jobs.length, 1);
  assert.match(m.log().at(-1)!, /lunch break until/);
});

test("a lunch break on the rota is taken and the rota moves past it", async () => {
  const m = machine({
    machine: 'PROJECTS=a\nROTA="lunch:30 default"\n',
    free: () => "1\tbug\tB\n",
  });
  await tick(m.runner());
  assert.equal(m.jobs.length, 0);
  const state = readState(join(m.home, "runner", "state"));
  assert.equal(state.LUNCH_UNTIL, String(NOW / 1000 + 1800));
  assert.equal(state.ROTA_AT, "1");
});

test("a project whose checks fail logs why, and the rota doesn't move on to its lunch break", async () => {
  const m = machine({ machine: 'PROJECTS=a\nROTA="default lunch:30"\n', freeFails: true });
  await tick(m.runner());
  assert.match(m.log().at(-1)!, /not run: a: factory free failed: gh: Bad credentials/);
  assert.deepEqual(readState(join(m.home, "runner", "state")), {});
});

test("memos with news go to the meeting's Memos step, run alone", async () => {
  const m = machine({ memoIds: "3\n" });
  await tick(m.runner());
  assert.equal(m.jobs.length, 1);
  assert.match(
    m.jobs[0]!.args[1]!,
    /aviously-a-factory:meeting skill and do only its step 2, Memos, run alone unattended, on these memos: https:\/\/github.com\/o\/trail\/issues\/3\.$/,
  );
  assert.equal(readFileSync(join(m.home, "a", "memos", "3"), "utf8"), "OPEN 1 -");
});

test("a live runner holds the lock and the tick says busy", async () => {
  const m = machine();
  mkdirSync(join(m.home, "runner", "lock"), { recursive: true });
  writeFileSync(join(m.home, "runner", "lock", "pid"), "42");
  writeFileSync(join(m.home, "runner", "lock", "step"), "shift a");
  await tick(m.runner());
  assert.match(m.log().at(-1)!, /busy: shift a, pid 42/);
  assert.equal(m.calls.length, 0);
});

test("a stopping machine with nothing in flight and the queue off turns itself off", async () => {
  const m = machine({ free: () => "1\tbug\tB\n" });
  mkdirSync(join(m.home, "runner"), { recursive: true });
  writeFileSync(join(m.home, "runner", "stopping"), "");
  await tick(m.runner());
  assert.equal(m.jobs.length, 0);
  assert.equal(m.offs(), 1);
  assert.match(m.log().at(-1)!, /stopped: queue empty, nothing in flight here; runner off/);
});

test("a dry run prints what it would run and writes nothing", async () => {
  const m = machine({ free: () => "12\tfeature\tA\n" });
  await tick(m.runner(true));
  assert.equal(m.jobs.length, 0);
  assert.equal(existsSync(join(m.home, "runner")), false);
  assert.equal(shiftCount("a", m.home), 0);
  assert.match(m.printed.at(-1)!, /^would run: shift on a \(default, free: #12\)$/);
  assert.ok(m.printed.some((line) => /project a: .*queue off, unattended on/.test(line)));
});
