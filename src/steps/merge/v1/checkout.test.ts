import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { exec as shell } from "../../../runtime/exec.ts";
import { markerOf, passCovering } from "../../../runtime/markers.ts";
import {
  branchMoved,
  dropComment,
  ensureClone,
  linkFiles,
  notQueued,
  queuedOf,
} from "./checkout.ts";
import { built, RENUMBER, repo } from "./checkout.fixture.ts";

const ghPr = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/app/pull/${number}`,
  headRefName: `topic/${number}`,
  headRefOid: `head${number}`,
  labels: [] as { name: string }[],
  baseRefName: "main",
  isDraft: false,
  isCrossRepository: false,
  autoMergeRequest: { enabledAt: `2026-10-12T0${number}:00:00Z` } as { enabledAt: string } | null,
  ...overrides,
});

test("the queue is open pull requests on the base with auto-merge on, the earliest turned on first; the rest say why not", () => {
  const prs = [
    ghPr(1, { autoMergeRequest: { enabledAt: "2026-10-12T09:00:00Z" } }),
    ghPr(2),
    ghPr(3, { autoMergeRequest: null }),
    ghPr(4, { isDraft: true }),
    ghPr(5, { isCrossRepository: true }),
    ghPr(6, { baseRefName: "epic/billing" }),
  ];
  assert.deepEqual(
    queuedOf(prs, "main").map(({ number }) => number),
    [2, 1],
  );
  assert.deepEqual(
    prs.slice(2).map((pr) => notQueued(pr, "main")),
    [
      "has auto-merge off",
      "is a draft",
      "comes from a fork, which the queue can't push to",
      "targets epic/billing, not main",
    ],
  );
  assert.deepEqual(
    queuedOf(prs, "epic/billing").map(({ number }) => number),
    [6],
  );
});

test("a push refused because the branch moved is told apart from a failed hook", () => {
  assert.ok(branchMoved(" ! [rejected]        HEAD -> topic/1 (fetch first)"));
  assert.ok(branchMoved(" ! [rejected]        HEAD -> topic/1 (non-fast-forward)"));
  assert.ok(!branchMoved("error: failed to push some refs\npre-push: lint failed"));
});

test("a drop comment leads with the reason and what to do, and keeps the detail folded", () => {
  const body = dropComment(
    { summary: "it conflicts with main in a.ts", details: ["main at abcdef01"] },
    "studio:/tmp/factory-merge-queue-x",
  );
  assert.match(
    body,
    /^Merge queue dropped this: it conflicts with main in a\.ts\. Fix it, then turn auto-merge back on/,
  );
  assert.match(
    body,
    /<details><summary>For AI<\/summary>\n\n- main at abcdef01\n- logs: studio:\/tmp\/factory-merge-queue-x/,
  );
});

test("a head merged with main twice is the same commit, with what each check needs", async () => {
  const { deps, pr, ran } = repo();
  const main = deps.fetchMain();
  const first = built(await deps.mergeMain(pr(1), main));
  // Git dates commits to the second.
  await new Promise((done) => setTimeout(done, 1_100));
  const again = built(await deps.mergeMain(pr(1), main));
  assert.equal(first.sha, again.sha);
  assert.deepEqual(Object.fromEntries(first.needs), {
    checks: { units: [] },
    web: { units: ["new.spec.ts"] },
  });
  assert.deepEqual(
    ran.find(([what]) => what === "select"),
    ["select", main],
  );
});

test("a head that changes only docs needs no check", async () => {
  const { deps, pr } = repo();
  const head = built(await deps.mergeMain(pr(5), deps.fetchMain()));
  assert.deepEqual(Object.fromEntries(head.needs), { checks: undefined, web: undefined });
});

test("a head that conflicts with main names the files and leaves the checkout clean", async () => {
  const { deps, pr, status } = repo();
  const result = await deps.mergeMain(pr(2), deps.fetchMain());
  assert.deepEqual(result, { conflict: "conflicts with main in c.ts" });
  assert.equal(status(), "");
});

test("a fixup mends a conflict on the merge before it's committed, and one that can't says why and leaves the checkout clean", async () => {
  const plain = repo();
  assert.deepEqual(await plain.deps.mergeMain(plain.pr(3), plain.deps.fetchMain()), {
    conflict: "conflicts with main in migrations/journal",
  });

  const { deps, pr, show } = repo({ merge: { fixups: [RENUMBER] } });
  const head = built(await deps.mergeMain(pr(3), deps.fetchMain()));
  assert.equal(show(head.sha, "migrations/0003_mine.sql").stdout, "CREATE TABLE mine;\n");
  assert.equal(show(head.sha, "migrations/0002_theirs.sql").stdout, "CREATE TABLE theirs;\n");
  assert.notEqual(show(head.sha, "migrations/0002_mine.sql").status, 0);
  assert.equal(show(head.sha, "migrations/journal").stdout, "0001_init\n0002_theirs\n0003_mine\n");
  const untouched = built(await deps.mergeMain(pr(1), deps.fetchMain()));
  assert.equal(show(untouched.sha, "b.ts").stdout, "b\n");

  const refusing = repo({
    merge: { fixups: ['echo "takes a number main took; renumber it by hand"; exit 1'] },
  });
  const result = await refusing.deps.mergeMain(refusing.pr(1), refusing.deps.fetchMain());
  assert.deepEqual(result, { conflict: "takes a number main took; renumber it by hand" });
  assert.equal(refusing.status(), "");
});

test("a merge is committed through the pre-commit hook, and one the hook refuses is left for a person", async () => {
  const hooked = (hook: string) => {
    const fake = repo();
    const hooks = mkdtempSync(join(tmpdir(), "factory-merge-queue-hooks-"));
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\n${hook}\n`, { mode: 0o755 });
    shell("git", ["config", "core.hooksPath", hooks], { cwd: fake.clone });
    return { ...fake, marker: join(hooks, "ran") };
  };
  const passing = hooked('touch "$(dirname "$0")/ran"');
  built(await passing.deps.mergeMain(passing.pr(1), passing.deps.fetchMain()));
  assert.ok(existsSync(passing.marker));
  const refusing = hooked("exit 1");
  const result = await refusing.deps.mergeMain(refusing.pr(1), refusing.deps.fetchMain());
  assert.deepEqual(result, {
    conflict: "couldn't commit its merge with main, or its pre-commit hook failed",
  });
  assert.equal(refusing.status(), "");
});

test("the test branch is main plus each head in order; one head fast-forwards, and a head that conflicts with an earlier one is left out", async () => {
  const { deps, pr } = repo({ merge: { fixups: [RENUMBER] } });
  const main = deps.fetchMain();
  const one = built(await deps.mergeMain(pr(1), main));
  const alone = deps.testBranch(main, [one]);
  assert.equal(alone.tip, one.sha);
  assert.deepEqual(alone.trees, [one.tree]);
  const three = built(await deps.mergeMain(pr(3), main));
  const both = deps.testBranch(main, [one, three]);
  assert.deepEqual(both.left, []);
  assert.equal(both.trees[0], one.tree);
  assert.equal(both.trees.length, 2);
  const four = built(await deps.mergeMain(pr(4), main));
  const clashing = deps.testBranch(main, [one, four, three]);
  assert.deepEqual(
    clashing.left.map(({ pr }) => pr.number),
    [4],
  );
  assert.deepEqual(clashing.trees, both.trees);
});

test("a test branch's pass covers a commit with the tree of one of its steps, and nothing else", async () => {
  const { deps, pr, clone } = repo({ merge: { fixups: [RENUMBER] } });
  const main = deps.fetchMain();
  const one = built(await deps.mergeMain(pr(1), main));
  const three = built(await deps.mergeMain(pr(3), main));
  const { tip, trees } = deps.testBranch(main, [one, three]);
  const marker = markerOf("checks");
  assert.equal(passCovering(deps.markers.read(marker), one.sha, shell, clone), undefined);
  deps.markers.write(marker, [tip, ...trees].join(" "));
  const record = deps.markers.read(marker);
  assert.equal(passCovering(record, one.sha, shell, clone), tip);
  assert.equal(passCovering(record, tip, shell, clone), tip);
  assert.equal(passCovering(record, main, shell, clone), undefined);
});

test("a head is pushed with the pre-push hook left on, then gets every check's status", async () => {
  const { deps, pr, ran, asked } = repo();
  const head = built(await deps.mergeMain(pr(1), deps.fetchMain()));
  assert.equal(await deps.land(head), "landed");
  assert.deepEqual(
    ran.filter((command) => command[1] === "push"),
    [["git", "push", "origin", "HEAD:refs/heads/topic/1"]],
  );
  const posted = asked.filter(({ args }) => args.includes("--method"));
  assert.deepEqual(
    posted.map(({ args }) => args.find((arg) => arg.startsWith("context="))),
    ["context=signoff/checks", "context=signoff/web"],
  );
  assert.ok(posted.every(({ args }) => args.includes(`repos/{owner}/{repo}/statuses/${head.sha}`)));
  assert.ok(posted.every(({ args }) => args.includes("description=merge queue")));
});

test("a check that failed for a pull request posts its status as failed on the head", () => {
  const { deps, pr, asked, checks } = repo();
  deps.failed(pr(1), checks[1]!, "new.spec.ts failed on main plus this pull request");
  const [posted] = asked.filter(({ args }) => args.includes("--method"));
  assert.ok(posted!.args.includes(`repos/{owner}/{repo}/statuses/${pr(1).headRefOid}`));
  assert.ok(posted!.args.includes("state=failure"));
  assert.ok(posted!.args.includes("context=signoff/web"));
});

test("a check runs its command on the commit with its units, and its output lands in the shift's log for that check", async () => {
  const { deps, pr, ran, checks, checkLogs } = repo();
  const main = deps.fetchMain();
  const head = built(await deps.mergeMain(pr(1), main));
  assert.deepEqual(await deps.runCheck(checks[1]!, head.sha, main, ["new.spec.ts"], 0), {
    failed: [],
  });
  assert.deepEqual(ran.at(-1), ["sh", "-c", 'pnpm e2e:spec --build "$@"', "sh", "new.spec.ts"]);
  assert.equal(
    readFileSync(join(checkLogs, "web.log"), "utf8"),
    "== pnpm e2e:spec --build new.spec.ts\nrunning\n\n",
  );
});

test("a failed install fails what needed it instead of stopping the queue, while a git failure stops it", async () => {
  const { deps, pr, checks } = repo({ install: false });
  const main = deps.fetchMain();
  const head = built(await deps.mergeMain(pr(1), main));
  assert.deepEqual(await deps.runCheck(checks[0]!, head.sha, main, [], 0), { failed: ["checks"] });
  assert.deepEqual(await deps.runCheck(checks[1]!, head.sha, main, ["new.spec.ts"], 0), {
    failed: ["new.spec.ts"],
  });
  assert.deepEqual(await deps.land(head), {
    failed: "installing dependencies failed on main plus this pull request",
  });
  await assert.rejects(deps.runCheck(checks[0]!, "0".repeat(40), main, [], 0), /git checkout/);
});

test("a check run past its timeout fails and names the timeout", async () => {
  const { deps, lines, checks } = repo({ slow: true, timeout: "0.001" });
  const main = deps.fetchMain();
  assert.deepEqual(await deps.runCheck(checks[1]!, main, main, ["zones.spec.ts"], 0), {
    failed: ["zones.spec.ts"],
  });
  assert.match(
    lines.join("\n"),
    /merge-queue: `pnpm e2e:spec --build` ran past TIMEOUT_E2E \(0\.001 min\); counting it as failed/,
  );
});

test("a push refused because the branch moved starts over; a failed hook or status says which", async () => {
  const moved = repo({
    push: { ok: false, output: " ! [rejected] HEAD -> topic/1 (fetch first)" },
  });
  const head = (fake: ReturnType<typeof repo>) =>
    fake.deps.mergeMain(fake.pr(1), fake.deps.fetchMain()).then(built);
  assert.equal(await moved.deps.land(await head(moved)), "moved");
  const hook = repo({ push: { ok: false, output: "pre-push: lint failed" } });
  assert.deepEqual(await hook.deps.land(await head(hook)), {
    failed: "the push to its branch failed, or its pre-push hook did",
  });
  const unsigned = repo({ status: false });
  assert.deepEqual(await unsigned.deps.land(await head(unsigned)), {
    failed: "posting signoff/checks failed: no",
  });
});

test("the queue merges a signed-off pull request itself by the project's method, and ends when auto-merge stays off, when main moves first, or with how it stands", async () => {
  const view = (state: string, auto: boolean, merge = "BLOCKED") =>
    JSON.stringify({ state, autoMergeRequest: auto ? {} : null, mergeStateStatus: merge });
  const merges = repo({ gh: { "pr view": [view("OPEN", true, "CLEAN")] } });
  assert.equal(await merges.deps.merged(merges.pr(1)), "merged");
  assert.deepEqual(
    merges.asked.map(({ args }) => args.slice(0, 2).join(" ")),
    ["pr view", "pr merge"],
  );
  assert.deepEqual(merges.asked.at(-1)?.args, ["pr", "merge", "1", "--squash", "--delete-branch"]);
  const commits = repo({ merge: { method: "merge" }, gh: { "pr view": [view("OPEN", true)] } });
  assert.equal(await commits.deps.merged(commits.pr(1)), "merged");
  assert.deepEqual(commits.asked.at(-1)?.args, ["pr", "merge", "1", "--merge", "--delete-branch"]);
  const off = repo({ gh: { "pr view": [view("OPEN", false), view("OPEN", false)] } });
  assert.equal(await off.deps.merged(off.pr(1)), "dequeued");
  assert.ok(!off.asked.some(({ args }) => args[1] === "merge"));
  const merging = repo({ gh: { "pr view": [view("OPEN", false), view("MERGED", false)] } });
  assert.equal(await merging.deps.merged(merging.pr(1)), "merged");
  const behind = repo({ gh: { "pr view": [view("OPEN", true, "BEHIND")] } });
  assert.equal(await behind.deps.merged(behind.pr(1)), "behind");
  const fellBehind = repo({
    refuse: "head branch is not up to date",
    gh: { "pr view": [view("OPEN", true), view("OPEN", true, "BEHIND")] },
  });
  assert.equal(await fellBehind.deps.merged(fellBehind.pr(1)), "behind");
  const raced = repo({
    refuse: "already merged",
    gh: { "pr view": [view("OPEN", true), view("MERGED", false)] },
  });
  assert.equal(await raced.deps.merged(raced.pr(1)), "merged");
  const stuck = repo({
    refuse: "the base branch policy prohibits the merge\nmore",
    gh: { "pr view": Array(100).fill(view("OPEN", true)) },
  });
  assert.deepEqual(await stuck.deps.merged(stuck.pr(1)), {
    stuck: "open, blocked: the base branch policy prohibits the merge",
  });
  assert.equal(stuck.asked.filter(({ args }) => args[1] === "merge").length, 6);
  assert.equal(stuck.sleeps(), 5);
});

test("gh answering with something other than JSON reads as a state it can't say, and a wait that looks again", async () => {
  const garbled = "<html>Bad gateway</html>";
  const states = repo({ gh: { "pr view": [garbled, JSON.stringify({ state: "MERGED" })] } });
  assert.equal(states.deps.state(states.pr(1)), undefined);
  assert.equal(states.deps.state(states.pr(1)), "merged");
  const view = JSON.stringify({ state: "MERGED", autoMergeRequest: null, mergeStateStatus: "" });
  const waits = repo({ gh: { "pr view": [garbled, view] } });
  assert.equal(await waits.deps.merged(waits.pr(1)), "merged");
});

test("the queue clones and marks its own checkout, links the files the project names, and refuses a checkout without the mark", () => {
  const { work, clone } = repo();
  writeFileSync(join(work, ".env"), "SECRET=1\n");
  const dir = join(dirname(clone), "queue");
  const lines: string[] = [];
  ensureClone(dir, work, [".env", ".env.local"], shell, (line) => lines.push(line));
  assert.match(lines[0]!, /cloning .* into .*queue$/);
  assert.equal(shell("git", ["rev-parse", "origin/main"], { cwd: dir }).status, 0);
  assert.equal(shell("git", ["config", "factory.mergeQueue"], { cwd: dir }).stdout.trim(), "true");
  assert.equal(readlinkSync(join(dir, ".env")), join(work, ".env"));
  assert.match(lines.join("\n"), /no \.env\.local in .* to link/);
  ensureClone(dir, work, [], shell, () => {});
  assert.throws(
    () => ensureClone(work, work, [], shell, () => {}),
    /isn't a clone the merge queue made, and a run would wipe its work/,
  );
});

test("a broken link is replaced, and a file the clone has is left alone", () => {
  const main = mkdtempSync(join(tmpdir(), "factory-links-main-"));
  const dir = mkdtempSync(join(tmpdir(), "factory-links-clone-"));
  writeFileSync(join(main, ".env"), "A=1\n");
  writeFileSync(join(main, "keep"), "main\n");
  writeFileSync(join(dir, "keep"), "mine\n");
  shell("ln", ["-s", join(main, "gone"), join(dir, ".env")]);
  assert.deepEqual(linkFiles(dir, main, [".env", "keep"]), [
    `linked .env -> ${join(main, ".env")}`,
  ]);
  assert.equal(readFileSync(join(dir, "keep"), "utf8"), "mine\n");
});

test("dropping turns auto-merge off and comments why", () => {
  const { deps, pr, asked } = repo();
  deps.drop(pr(2), { summary: "it conflicts with main in c.ts" });
  assert.deepEqual(
    asked.map(({ args }) => args),
    [
      ["pr", "merge", "2", "--disable-auto"],
      ["pr", "comment", "2", "--body-file", "-"],
    ],
  );
  assert.match(asked[1]!.input!, /^Merge queue dropped this: it conflicts with main in c\.ts\./);
});

test("a fresh clone installs a merged head's dependencies before the checks' selection imports them", async () => {
  const { deps, pr, ran } = repo();
  built(await deps.mergeMain(pr(1), deps.fetchMain()));
  assert.deepEqual(
    ran.map((command) => command[0]),
    ["sh", "select"],
  );
  assert.match(ran[0]![2]!, /^pnpm install --frozen-lockfile/);
});
