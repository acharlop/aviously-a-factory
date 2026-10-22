import assert from "node:assert/strict";
import { test } from "node:test";

import type { Exec } from "../../../runtime/exec.ts";
import { type Deps, parseArgs, push } from "./push.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";
const BRANCH = "tooling/866-push";

type World = {
  branch?: string;
  body?: string;
  assignees?: string[];
  claim?: string;
  prs?: { url: string; headRefName: string }[];
  changed?: string;
  dirty?: boolean;
  pushFails?: boolean;
  comments?: string[];
  number?: number;
  shots?: string;
};

/** A fake git and gh answering from world, recording each call. */
function fake(world: World = {}) {
  const calls: string[] = [];
  const inputs: string[] = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const answer: Exec = (command, args) => {
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    if (call === "git rev-parse --abbrev-ref HEAD") return ok(`${world.branch ?? BRANCH}\n`);
    if (call === "git rev-parse HEAD") return ok(`${HEAD}\n`);
    if (call.startsWith("git merge-base")) return ok("base000\n");
    if (call.startsWith("git diff --name-only")) return ok(world.changed ?? "src/a.ts\n");
    if (call === "git status --porcelain") return ok(world.dirty ? " M a.ts\n" : "");
    if (call.startsWith("git push") && world.pushFails)
      return { status: 1, stdout: "", stderr: "pre-push: checks failed\n" };
    if (call.startsWith("gh issue view"))
      return ok(
        JSON.stringify({
          assignees: (world.assignees ?? ["avi"]).map((login) => ({ login })),
          labels: [{ name: "in-progress" }, { name: "ready-for-agent" }],
          comments: [
            { body: `In progress on branch \`${world.claim ?? BRANCH}\` on studio` },
            ...(world.comments ?? []).map((body) => ({ body })),
          ],
        }),
      );
    if (call.startsWith("gh pr list")) return ok(JSON.stringify(world.prs ?? []));
    if (call.startsWith("gh api user")) return ok("avi\n");
    if (call.startsWith("gh pr create")) return ok("https://github.com/o/app/pull/990\n");
    return ok();
  };
  const sh: Exec = (command, args, options = {}) => {
    if (options.input !== undefined) inputs.push(options.input);
    return answer(command, args);
  };
  const said: string[] = [];
  const deps: Deps = {
    sh,
    migrations: ["packages/db/src/schema/**"],
    method: "squash",
    bodyFile: "/wt/.git/factory-pr-body.md",
    read: () => world.body ?? "# Tooling: the PR as it stands\n\nFixes the thing\n",
    shotsIn: (dir) => [`${dir}/566-list.png`, `${dir}/en/866-a.png`, `${dir}/he/866-a.png`],
    log: (line) => said.push(line),
  };
  return { deps, calls, inputs, said };
}

const pushing = { number: 866, autoMerge: true };
const did = (calls: string[], start: string) => calls.filter((call) => call.startsWith(start));

test("a reviewed branch is pushed, gets a ready PR with its shots, auto-merge and its Reviewed comment", () => {
  const { deps, calls, inputs, said } = fake();
  assert.equal(push({ ...pushing, shots: "/shots" }, deps), true);
  assert.deepEqual(did(calls, "git push"), [`git push -u origin ${BRANCH}`]);
  assert.deepEqual(did(calls, "gh pr create"), [
    `gh pr create --head ${BRANCH} --title Tooling: the PR as it stands --body-file - --attach /shots/en/866-a.png --attach /shots/he/866-a.png`,
  ]);
  assert.deepEqual(inputs, ["Fixes the thing"]);
  assert.deepEqual(did(calls, "gh pr merge"), [
    "gh pr merge https://github.com/o/app/pull/990 --auto --squash --delete-branch",
  ]);
  assert.deepEqual(did(calls, "gh issue comment"), [
    `gh issue comment 866 --body Reviewed at \`${HEAD}\``,
  ]);
  assert.deepEqual(said.slice(-2), ["PR: https://github.com/o/app/pull/990", "auto-merge: on"]);
});

test("auto-merge merges by the project's method", () => {
  const { deps, calls } = fake();
  assert.equal(push(pushing, { ...deps, method: "rebase" }), true);
  assert.deepEqual(did(calls, "gh pr merge"), [
    "gh pr merge https://github.com/o/app/pull/990 --auto --rebase --delete-branch",
  ]);
});

test("auto-merge off leaves it off, and --title names the PR", () => {
  const { deps, calls, said } = fake();
  assert.equal(push({ number: 866, autoMerge: false, title: "Given title" }, deps), true);
  assert.match(did(calls, "gh pr create")[0]!, /--title Given title --body-file -/);
  assert.deepEqual(did(calls, "gh pr merge"), []);
  assert.equal(said.at(-1), "auto-merge: off");
});

test("a branch with a PR already open gets its title and body updated, and no second Reviewed comment for HEAD", () => {
  const url = "https://github.com/o/app/pull/977";
  const { deps, calls, inputs } = fake({
    prs: [{ url, headRefName: BRANCH }],
    comments: [`Reviewed at \`${HEAD.slice(0, 8)}\``],
    body: "# Tooling: the title after rework\nFixes it all",
  });
  assert.equal(push(pushing, deps), true);
  assert.deepEqual(did(calls, "gh pr create"), []);
  assert.deepEqual(did(calls, "gh pr edit"), [
    `gh pr edit ${url} --title Tooling: the title after rework --body-file -`,
  ]);
  assert.deepEqual(inputs, ["Fixes it all"]);
  assert.deepEqual(did(calls, "gh issue comment"), []);
});

const refusals: [string, World, RegExp][] = [
  [
    "the branch isn't the ticket's",
    { branch: "tooling/867-other" },
    /isn't a <department>\/866-<slug> branch/,
  ],
  ["the PR body is empty", { body: " \n" }, /no PR body in \/wt\/.git\/factory-pr-body.md/],
  ["the PR body has only its title", { body: "# Tooling: a title\n" }, /no PR body in/],
  ["the PR body has no title line", { body: "Fixes the thing" }, /no `# <title>` first line/],
  [
    "the ticket is assigned elsewhere",
    { assignees: ["someone"] },
    /claim is lost \(avi is no longer assigned\)/,
  ],
  [
    "a later claim names another branch",
    { claim: "web/866-theirs" },
    /claim is lost \(the latest claim names web\/866-theirs\)/,
  ],
  [
    "another branch has a PR open for it",
    { prs: [{ url: "https://github.com/o/app/pull/5", headRefName: "x/866-y" }] },
    /claim is lost \(another PR is open for it: .*pull\/5\)/,
  ],
  [
    "a migrations glob matches a changed file",
    { changed: "src/a.ts\npackages/db/src/schema/orders.ts\n" },
    /schema changed \(packages\/db\/src\/schema\/orders.ts\): merge origin\/main/,
  ],
  ["the tree is dirty", { dirty: true }, /working tree isn't clean/],
  [
    "the shots folder holds only other tickets' shots",
    { branch: "tooling/86-push", claim: "tooling/86-push", number: 86, shots: "/shots" },
    /no screenshots named 86-\* in \/shots/,
  ],
];

for (const [name, world, why] of refusals)
  test(`nothing is pushed when ${name}`, () => {
    const { deps, calls, said } = fake(world);
    const shots = world.shots === undefined ? {} : { shots: world.shots };
    assert.equal(push({ ...pushing, number: world.number ?? 866, ...shots }, deps), false);
    assert.match(said.at(-1)!, why);
    assert.deepEqual(did(calls, "git push"), []);
    assert.deepEqual(did(calls, "gh pr"), did(calls, "gh pr list"));
    assert.deepEqual(did(calls, "gh issue comment"), []);
  });

test("a push the pre-push hook refuses opens no PR", () => {
  const { deps, calls, said } = fake({ pushFails: true });
  assert.equal(push(pushing, deps), false);
  assert.equal(said.at(-1), "factory push: stopped: git push: pre-push: checks failed");
  assert.deepEqual(did(calls, "gh pr create"), []);
});

test("the arguments need a ticket and an auto-merge of on or off", () => {
  assert.deepEqual(parseArgs(["866", "--auto-merge", "on", "--shots", "/s"]), {
    number: 866,
    autoMerge: true,
    shots: "/s",
  });
  assert.equal(parseArgs(["866"]), undefined);
  assert.equal(parseArgs(["866", "--auto-merge", "yes"]), undefined);
  assert.equal(parseArgs(["x", "--auto-merge", "off"]), undefined);
  assert.equal(parseArgs(["866", "--auto-merge", "off", "--shots"]), undefined);
});
