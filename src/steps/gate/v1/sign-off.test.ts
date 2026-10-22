import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { type Check, commandCheck, type Verdict } from "../../../runtime/checks.ts";
import { exec, type Exec } from "../../../runtime/exec.ts";
import type { SignOff } from "../../file/v1/sign-off.ts";
import { type Deps, signOff } from "./sign-off.ts";

const REACHED = ["sign-in", "chat"];

// A branch one commit ahead of where it left main, which has moved on since; gh and the selection are faked, git is real.
function repo({
  selected = "orders.spec.ts\n",
  passes = { checks: true, web: true } as Record<string, boolean>,
  gatePassed = false,
  mainTouches = "main.ts",
  signedIn = true,
  posts = true,
  /** The flows the device check finds the branch reaches. */
  flows = [] as string[],
  /** Whether this machine runs the device check. */
  device = false,
  verdict = { failed: [], notRun: [] } as Verdict,
  /** A file the branch changes beside topic.ts. */
  touches = undefined as string | undefined,
  /** The branch's open pull request and what its review threads query answers. */
  review = undefined as { number: number; pages: unknown[] } | undefined,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-sign-off-test-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const git = (...args: string[]) => {
    const result = exec("git", args, { cwd: work });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (file: string, content: string) => {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), content);
    git("add", "-A");
    git("commit", "--quiet", "-m", file);
  };
  exec("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  exec("git", ["clone", "--quiet", origin, work]);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  commit("readme.md", "hello\n");
  git("push", "--quiet", "origin", "HEAD:main");
  git("checkout", "--quiet", "-b", "topic");
  commit("topic.ts", "topic\n");
  if (touches) commit(touches, "native\n");
  git("push", "--quiet", "origin", "topic");
  git("checkout", "--quiet", "main");
  commit(mainTouches, "main\n");
  git("push", "--quiet", "origin", "main");
  git("checkout", "--quiet", "topic");
  git("reset", "--quiet", "--hard", "origin/topic");

  const events: string[] = [];
  const posted: string[][] = [];
  const records: SignOff[] = [];
  const lines: string[] = [];
  const sh: Exec = (command, args, options) => {
    if (command === "gh") {
      if (args[0] === "pr" && args[1] === "list")
        return { status: 0, stdout: JSON.stringify(review ? [review] : []), stderr: "" };
      if (args[1] === "graphql") {
        events.push(`review #${args.find((arg) => arg.startsWith("number="))?.slice(7)}`);
        return { status: 0, stdout: JSON.stringify(review?.pages ?? []), stderr: "" };
      }
      if (args[0] === "api") posted.push(args);
      const ok = args[0] === "api" ? posts : signedIn;
      return { status: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "no" };
    }
    if (command === "sh") {
      events.push(
        `select ${args.at(-1) === git("rev-parse", "origin/main") ? "main" : args.at(-1)}`,
      );
      return { status: 0, stdout: selected, stderr: "" };
    }
    return exec(command, args, { ...options, cwd: work });
  };
  const timing = { timeout: "TIMEOUT_VERIFY", tries: 1 } as const;
  const onDevice: Check = {
    name: "mobile",
    command: "device flows",
    timeout: "TIMEOUT_E2E",
    tries: 1,
    marker: false,
    needs: async ({ files }) =>
      flows.length > 0 || files?.some((file) => file.endsWith("eas.json"))
        ? { units: flows }
        : undefined,
    unavailable: () => (device ? undefined : "it runs no device flows"),
    run: async () => verdict,
    describe: (units) =>
      units.length > 0 ? `flows passed: ${units.join(", ")}` : "no flow reached",
  };
  const deps: Deps = {
    sh,
    checks: [
      commandCheck("checks", { run: "pnpm verify", ...timing }, sh),
      commandCheck(
        "web",
        { run: "pnpm e2e:spec --build", select: "node select.ts", ...timing },
        sh,
      ),
      onDevice,
    ],
    docs: ["docs/**", "**/*.md"],
    base: "origin/main",
    status: "signoff/",
    passed: () => gatePassed,
    lock: async () => {
      events.push("lock");
      return () => events.push("release");
    },
    run: async (check, _sha, units) => {
      events.push([check.command, ...units].join(" "));
      if (check === onDevice) return check.run({} as never);
      return { failed: passes[check.name] ? [] : [check.name] };
    },
    log: (line) => lines.push(line),
    record: (signOff) => {
      records.push(signOff);
      return `https://trail/${records.length}`;
    },
  };
  /** Lands a commit on origin's main from another clone, as another pull request merging would. */
  const moveMain = (file: string) => {
    const other = join(root, `other-${file}`);
    exec("git", ["clone", "--quiet", origin, other]);
    const at = (...args: string[]) => exec("git", args, { cwd: other });
    writeFileSync(join(other, file), "moved\n");
    at("add", "-A");
    at("-c", "user.name=Other", "-c", "user.email=o@example.com", "commit", "--quiet", "-m", file);
    assert.equal(at("push", "--quiet", "origin", "HEAD:main").status, 0);
  };
  const select = (text: string) => (selected = text);
  return { deps, git, events, posted, records, lines, moveMain, select };
}

const contexts = (posted: string[][]) =>
  posted.map((args) => [args[3], args.find((arg) => arg.startsWith("context="))]);

test("a branch behind main gets main merged in, each check it needs under the lock, then a push and every check's status on the merge", async () => {
  const { deps, git, events, posted, records } = repo();
  assert.equal(await signOff(deps), 0);
  const head = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD^1"), git("rev-parse", "origin/topic^1"));
  assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "origin/main"));
  assert.equal(git("rev-parse", "origin/topic"), head);
  assert.deepEqual(events, [
    "select main",
    "lock",
    "pnpm verify",
    "pnpm e2e:spec --build orders.spec.ts",
    "release",
  ]);
  assert.deepEqual(
    contexts(posted),
    ["checks", "web", "mobile"].map((check) => [
      `repos/{owner}/{repo}/statuses/${head}`,
      `context=signoff/${check}`,
    ]),
  );
  assert.ok(
    posted.slice(0, 2).every((args) => args.includes("description=factory signoff by Dev")),
  );
  assert.ok(posted[2]!.includes("description=no flow reached"));
  const ran = records.filter(({ outcome }) => outcome === "passed");
  assert.deepEqual(
    ran.map(({ outcome, check, sha, branch, base }) => ({ outcome, check, sha, branch, base })),
    ["checks", "web"].map((check) => ({
      outcome: "passed",
      check,
      sha: head,
      branch: "topic",
      base: "origin/main",
    })),
  );
  assert.ok(ran.every((run) => typeof run.durationMs === "number" && run.command));
});

test("a check whose recorded pass covers the head and a change that selects nothing run nothing, and still sign off", async () => {
  const { deps, events, posted, records } = repo({ gatePassed: true, selected: "" });
  assert.equal(await signOff(deps), 0);
  assert.deepEqual(events, ["select main", "lock", "release"]);
  assert.equal(posted.length, 3);
  assert.deepEqual(
    records.map(({ outcome, check }) => `${check} ${outcome}`),
    ["checks gated", "web unaffected", "mobile unaffected"],
  );
});

test("a docs-only branch needs no check, and still signs off", async () => {
  const { deps, git, events, posted } = repo({ mainTouches: "docs/main.md" });
  git("reset", "--quiet", "--hard", "HEAD~1");
  writeFileSync(join(git("rev-parse", "--show-toplevel"), "notes.md"), "notes\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "notes");
  git("push", "--quiet", "--force", "origin", "topic");
  assert.equal(await signOff(deps), 0);
  assert.deepEqual(events, ["lock", "release"]);
  assert.equal(posted.length, 3);
});

test("a branch that needs a check this machine can't run is refused before anything runs, saying where to sign it off", async () => {
  for (const given of [{ flows: REACHED }, { touches: "apps/mobile/eas.json" }]) {
    const { deps, git, events, posted, lines } = repo(given);
    const before = git("rev-parse", "origin/topic");
    assert.equal(await signOff(deps), 1);
    assert.deepEqual(events, ["select main"]);
    assert.deepEqual(posted, []);
    assert.equal(git("rev-parse", "origin/topic"), before, "nothing pushed");
    assert.match(
      lines.join("\n"),
      /the branch needs mobile.*, which this machine can't run: it runs no device flows; run `gh pr checkout topic` and sign off on one that can/,
    );
  }
});

test("a module check runs after the commands, and its status says what it ran", async () => {
  const { deps, events, posted, records } = repo({ flows: REACHED, device: true });
  assert.equal(await signOff(deps), 0);
  assert.deepEqual(events.slice(-2), ["device flows sign-in chat", "release"]);
  assert.ok(posted[2]!.includes("context=signoff/mobile"));
  assert.ok(posted[2]!.includes("description=flows passed: sign-in, chat"));
  assert.equal(records.at(-1)?.check, "mobile");
  assert.equal(records.at(-1)?.outcome, "passed");
});

test("a failed unit marks the pushed head's status failed, and a check that couldn't run refuses", async () => {
  const failed = repo({
    flows: REACHED,
    device: true,
    verdict: { failed: ["chat"], notRun: [] },
  });
  const pushed = failed.git("rev-parse", "origin/topic");
  assert.equal(await signOff(failed.deps), 1);
  assert.equal(failed.git("rev-parse", "origin/topic"), pushed);
  assert.equal(failed.posted.length, 1);
  assert.ok(failed.posted[0]!.includes(`repos/{owner}/{repo}/statuses/${pushed}`));
  assert.ok(failed.posted[0]!.includes("context=signoff/mobile"));
  assert.match(failed.lines.join("\n"), /mobile failed chat/);

  const held = repo({
    flows: REACHED,
    device: true,
    verdict: { unavailable: "/elsewhere holds the simulator" },
  });
  assert.equal(await signOff(held.deps), 1);
  assert.deepEqual(held.posted, []);
  assert.match(held.lines.join("\n"), /mobile couldn't run: \/elsewhere holds the simulator/);
});

test("a failed check stops there, pushes nothing, and marks the pushed head failed, linked to its sign-off", async () => {
  for (const [failing, ran] of [
    ["checks", ["select main", "lock", "pnpm verify", "release"]],
    [
      "web",
      ["select main", "lock", "pnpm verify", "pnpm e2e:spec --build orders.spec.ts", "release"],
    ],
  ] as const) {
    const { deps, git, events, posted, records } = repo({
      passes: { checks: true, web: true, [failing]: false },
    });
    assert.equal(await signOff(deps), 1);
    assert.deepEqual(events, ran);
    const pushed = git("rev-parse", "origin/topic");
    assert.notEqual(pushed, git("rev-parse", "HEAD"));
    assert.equal(records.at(-1)?.outcome, "failed");
    assert.deepEqual(posted, [
      [
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/statuses/${pushed}`,
        "-f",
        `context=signoff/${failing}`,
        "-f",
        "state=failure",
        "-f",
        `description=${failing} failed on ${git("rev-parse", "HEAD").slice(0, 8)}: factory signoff by Dev`,
        "-f",
        `target_url=https://trail/${records.length}`,
      ],
    ]);
  }
});

test("a branch that conflicts with main is left as it was, and sign-off says where", async () => {
  const { deps, git, events, lines, records } = repo({ mainTouches: "topic.ts" });
  const before = git("rev-parse", "HEAD");
  assert.equal(await signOff(deps), 1);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(events, []);
  assert.match(lines.at(-1)!, /topic conflicts with main in topic\.ts; merge origin\/main by hand/);
  assert.equal(records[0]?.outcome, "refused");
});

test("a pull request branch moved on GitHub is fast-forwarded to before main is merged in", async () => {
  const { deps, git } = repo();
  git("checkout", "--quiet", "-b", "elsewhere");
  writeFileSync(join(git("rev-parse", "--show-toplevel"), "update.ts"), "update\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "update");
  const moved = git("rev-parse", "HEAD");
  git("push", "--quiet", "origin", "HEAD:topic");
  git("checkout", "--quiet", "topic");
  assert.equal(await signOff(deps), 0);
  assert.equal(git("rev-parse", "HEAD^1"), moved);
  assert.equal(git("rev-parse", "origin/topic"), git("rev-parse", "HEAD"));
});

test("a branch that diverged from its pull request's branch is refused, naming both", async () => {
  const { deps, git, events, records } = repo();
  git("checkout", "--quiet", "-b", "elsewhere");
  writeFileSync(join(git("rev-parse", "--show-toplevel"), "update.ts"), "update\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "update");
  git("push", "--quiet", "origin", "HEAD:topic");
  git("checkout", "--quiet", "topic");
  writeFileSync(join(git("rev-parse", "--show-toplevel"), "local.ts"), "local\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "local");
  assert.equal(await signOff(deps), 1);
  assert.deepEqual(events, []);
  assert.match(records[0]!.reason!, /^topic \(\w{8}\) and origin\/topic \(\w{8}\) have diverged/);
});

test("an uncommitted change, main itself or a signed-out gh is refused before anything runs", async () => {
  const dirty = repo();
  writeFileSync(join(dirty.git("rev-parse", "--show-toplevel"), "topic.ts"), "changed\n");
  const onMain = repo();
  onMain.git("checkout", "--quiet", "main");
  const signedOut = repo({ signedIn: false });
  for (const [fake, why] of [
    [dirty, /uncommitted changes/],
    [onMain, /not main/],
    [signedOut, /gh isn't installed or signed in/],
  ] as const) {
    assert.equal(await signOff(fake.deps), 1);
    assert.deepEqual(fake.events, []);
    assert.match(fake.records[0]!.reason!, why);
  }
});

test("a checkout that moved while the checks ran posts nothing", async () => {
  const { deps, git, posted, records } = repo();
  const run = deps.run;
  deps.run = async (check, sha, units) => {
    if (check.name === "web")
      writeFileSync(join(git("rev-parse", "--show-toplevel"), "x.ts"), "x\n");
    return run(check, sha, units);
  };
  assert.equal(await signOff(deps), 1);
  assert.deepEqual(posted, []);
  assert.equal(records.at(-1)?.outcome, "not-posted");
});

test("a status GitHub refuses after the push is said and recorded as not posted", async () => {
  const { deps, git, lines, records } = repo({ posts: false });
  assert.equal(await signOff(deps), 1);
  assert.equal(git("rev-parse", "origin/topic"), git("rev-parse", "HEAD"));
  assert.equal(lines.at(-1), "sign-off: posting signoff/checks failed: no");
  assert.deepEqual(records.at(-1), {
    outcome: "not-posted",
    reason: "posting signoff/checks failed: no",
    branch: "topic",
    sha: git("rev-parse", "HEAD"),
    base: "origin/main",
  });
});

const openThread = {
  data: {
    repository: {
      pullRequest: {
        reviewDecision: "CHANGES_REQUESTED",
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              path: "src/queue.ts",
              line: 113,
              comments: { nodes: [{ author: { login: "reviewbot" }, body: "High: leak\nmore" }] },
            },
          ],
        },
      },
    },
  },
};

test("a pull request with an open review thread or changes requested is refused before main is merged or anything runs", async () => {
  const { deps, git, events, posted, records } = repo({
    review: { number: 42, pages: [openThread] },
  });
  const before = git("rev-parse", "HEAD");
  assert.equal(await signOff(deps), 1);
  assert.equal(git("rev-parse", "HEAD"), before, "main not merged");
  assert.deepEqual(events, ["review #42"]);
  assert.deepEqual(posted, []);
  assert.equal(records[0]?.outcome, "refused");
  assert.equal(
    records[0]?.reason,
    "#42 can't merge until its review is settled; resolve each thread (fix it, or reply and resolve) and clear requested changes first:\n  - open review thread at src/queue.ts:113 by reviewbot: High: leak\n  - a reviewer requested changes",
  );
});

test("a pull request whose threads are all resolved signs off", async () => {
  const resolved = structuredClone(openThread);
  resolved.data.repository.pullRequest.reviewDecision = "APPROVED";
  resolved.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved = true;
  const { deps, events } = repo({ review: { number: 42, pages: [resolved] } });
  assert.equal(await signOff(deps), 0);
  assert.equal(events[0], "review #42");
});

test("main moving while the checks run is merged in again, and the merged head is pushed and signed off when it needs the same", async () => {
  const { deps, git, events, posted, lines, moveMain } = repo();
  const run = deps.run;
  deps.run = async (check, sha, units) => {
    if (check.name === "web") moveMain("later.ts");
    return run(check, sha, units);
  };
  assert.equal(await signOff(deps), 0);
  const head = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "origin/main"));
  assert.equal(git("rev-parse", "origin/topic"), head);
  assert.deepEqual(
    events.filter((event) => event.startsWith("pnpm")),
    ["pnpm verify", "pnpm e2e:spec --build orders.spec.ts"],
  );
  assert.ok(posted.every((args) => args[3] === `repos/{owner}/{repo}/statuses/${head}`));
  assert.match(lines.join("\n"), /origin\/main moved while the checks ran, needing the same/);
});

test("a commit made on the branch while the checks run is refused, never signed off with the old run's statuses", async () => {
  const { deps, git, posted, lines, moveMain } = repo();
  const run = deps.run;
  deps.run = async (check, sha, units) => {
    if (check.name === "web") {
      writeFileSync(join(git("rev-parse", "--show-toplevel"), "late.ts"), "late\n");
      git("add", "late.ts");
      git("commit", "-qm", "late");
      moveMain("later.ts");
    }
    return run(check, sha, units);
  };
  assert.equal(await signOff(deps), 1);
  assert.deepEqual(posted, []);
  assert.match(lines.join("\n"), /HEAD changed while the checks were running/);
});

test("main moving to change what the branch needs runs the checks again on the new merge", async () => {
  const { deps, git, events, posted, moveMain, select } = repo();
  const run = deps.run;
  let moved = false;
  deps.run = async (check, sha, units) => {
    if (check.name === "web" && !moved) {
      moved = true;
      moveMain("later.ts");
      select("orders.spec.ts\nzones.spec.ts\n");
    }
    return run(check, sha, units);
  };
  assert.equal(await signOff(deps), 0);
  const head = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "origin/main"));
  assert.deepEqual(
    events.filter((event) => event.startsWith("pnpm")),
    [
      "pnpm verify",
      "pnpm e2e:spec --build orders.spec.ts",
      "pnpm verify",
      "pnpm e2e:spec --build orders.spec.ts zones.spec.ts",
    ],
  );
  assert.ok(posted.every((args) => args[3] === `repos/{owner}/{repo}/statuses/${head}`));
});
