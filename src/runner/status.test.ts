import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { jumpIn, since, status, stuck, transcriptsOf, unsettled } from "./status.ts";

const now = Date.parse("2026-10-14T12:00:00Z");
const calm = {
  runnerLock: undefined,
  lunchUntil: undefined,
  launchd: false,
  lastTickMs: undefined,
  now,
  home: "/h/.factory",
};

test("a session's transcripts sit under its cwd with every non-alphanumeric as a dash", () => {
  assert.equal(
    transcriptsOf("/Users/j/code/app-wt/656-cleanups", "/Users/j"),
    "/Users/j/.claude/projects/-Users-j-code-app-wt-656-cleanups",
  );
});

test("a hand-started shift is joined through the runner, a background session by claude attach, one in tmux through tmux, any other is resumed by its id", () => {
  const s = { cwd: "/x", sessionId: "s" };
  assert.equal(
    jumpIn({ ...s, pid: 7, tmux: "factory:@0.%0" }, new Set([7])),
    "factory runner shift",
  );
  assert.equal(jumpIn({ ...s, pid: 8, kind: "bg", jobId: "49c1a723" }), "claude attach 49c1a723");
  assert.equal(jumpIn({ ...s, pid: 9, tmux: "factory:@0.%0" }), "tmux attach -t factory");
  assert.match(jumpIn({ pid: 1, cwd: "/x", sessionId: "abc" }), /^cd \/x && claude --resume abc/);
});

test("a start prints as local clock time and minutes ago, from epoch ms or an ISO string", () => {
  const start = now - 34 * 60_000;
  const d = new Date(start);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.equal(since(start, now), `${clock} · 34 min`);
  assert.equal(since(new Date(start).toISOString(), now), `${clock} · 34 min`);
  assert.equal(since(undefined, now), "?");
});

test("nothing is stuck on a calm machine", () => {
  assert.deepEqual(stuck(calm), []);
});

test("a dead lock holder, a lunch break and a silent runner each say what to run", () => {
  const lines = stuck({
    ...calm,
    runnerLock: { pid: 12, alive: false, step: "shift a" },
    lunchUntil: now + 60_000,
    launchd: true,
    lastTickMs: now - 45 * 60_000,
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /runner lock held by dead pid 12 → rm -rf \/h\/.factory\/runner\/lock/);
  assert.match(lines[1]!, /lunch break until/);
  assert.match(lines[2]!, /launchctl kickstart -k gui\/\$\(id -u\)\/aviously-a-factory.runner/);
});

test("a quiet log while a live tick holds the runner lock isn't stuck, nor a past lunch break", () => {
  assert.deepEqual(
    stuck({
      ...calm,
      runnerLock: { pid: 12, alive: true, step: "shift a" },
      launchd: true,
      lastTickMs: now - 90 * 60_000,
      lunchUntil: now - 1000,
    }),
    [],
  );
});

test("a memo needs you only for follow-ups not yet filed or answered", () => {
  const body = [
    "### Calls made",
    "- [ ] A call stands unless someone comments",
    "### Proposed follow-ups",
    "- [x] Filed → [#690 📋](https://github.com/o/p/issues/690)",
    "- [ ] Dropped → https://github.com/o/trail/issues/3#issuecomment-1",
    "- [ ] Rename queue.log → queue.jsonl",
    "- [x] Ticked, not filed yet",
  ].join("\n");
  assert.equal(unsettled(body), 2);
});

test("the screen lists each project served, what's in flight there and its queue", () => {
  const home = mkdtempSync(join(tmpdir(), "factory-status-"));
  writeFileSync(join(home, "machine"), "PROJECTS=a\n");
  const sh: Exec = (command, args) => {
    if (command === "pnpm" && args.includes("in-flight"))
      return { status: 0, stdout: "4\tFix it\tweb/4-fix\tmerge\n", stderr: "" };
    if (command === "gh" && args[0] === "pr")
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 9, title: "Q", autoMergeRequest: {} }]),
        stderr: "",
      };
    return { status: 1, stdout: "", stderr: "" };
  };
  mkdirSync(join(home, "a"));
  writeFileSync(join(home, "a", "config"), `CHECKOUT=${home}\n`);
  const heavyLock = join(home, "locks", "heavy");
  mkdirSync(heavyLock, { recursive: true });
  writeFileSync(
    join(heavyLock, "owner.json"),
    JSON.stringify({
      pid: 77,
      command: "factory queue",
      cwd: "/c",
      startedAt: "2026-10-14T11:00:00Z",
    }),
  );
  const lines = status({ home, heavyLock, user: home, sh, now, alive: () => false }).join("\n");
  assert.match(lines, /PROJECT  a · .* · shift 0 · queue off/);
  assert.match(lines, /IN FLIGHT ON a\n  #4  Fix it\n    branch web\/4-fix · next: merge/);
  assert.match(lines, /QUEUE ON a \(auto-merge on\)\n  #9  Q/);
  assert.match(
    lines,
    /HEAVY    pid 77 \(`factory queue` in \/c\) since .* \(dead; the next taker clears it\)/,
  );
  assert.match(lines, /nothing looks stuck/);
});
