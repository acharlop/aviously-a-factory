import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseConfig } from "../../../config/load.ts";
import { type Check, commandCheck } from "../../../runtime/checks.ts";
import { exec as shell, type Exec } from "../../../runtime/exec.ts";
import type { SignOff } from "../../file/v1/sign-off.ts";
import { commandFixup, queueCheckout } from "./checkout.ts";
import type { Built, Pr } from "./queue.ts";

// What gh answers, by its first two arguments, what a push prints and returns, and what the spec selection prints.
type Fakes = {
  gh?: Record<string, string[]>;
  push?: { ok: boolean; output: string };
  /** Whether posting a commit status works. */
  status?: boolean;
  /** What `gh pr merge` says when GitHub refuses it; it merges when unset. */
  refuse?: string;
  selected?: string;
  install?: boolean;
  /** A check run that runs until its timeout stops it. */
  slow?: boolean;
  /** factory.config.ts's merge section, and its gate section's settings beside the checks. */
  merge?: object;
  gate?: object;
  /** Minutes before a check run counts as failed. */
  timeout?: string;
};

/** The fixup a project could write for numbered migrations: a journal that conflicts takes main's and the branch's migration moves after main's. */
export const RENUMBER = [
  "git diff --name-only --diff-filter=U | grep -qx migrations/journal || exit 0",
  'git show "$FACTORY_MAIN:migrations/journal" > migrations/journal',
  "echo 0003_mine >> migrations/journal",
  "git mv migrations/0002_mine.sql migrations/0003_mine.sql",
  "git add migrations/journal",
].join(" && ");

export function repo({
  gh = {},
  push = { ok: true, output: "" },
  status = true,
  refuse,
  selected = "new.spec.ts\n",
  install = true,
  slow = false,
  merge = {},
  gate = {},
  timeout,
}: Fakes = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-merge-queue-test-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const clone = join(root, "clone");
  const sh = (cwd: string, ...args: string[]) => {
    const result = shell("git", args, { cwd });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), content);
    }
  };
  const commit = (message: string, files: Record<string, string>) => {
    write(files);
    sh(work, "add", "-A");
    sh(work, "commit", "--quiet", "-m", message);
    return sh(work, "rev-parse", "HEAD");
  };
  shell("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  shell("git", ["init", "--quiet", "-b", "main", work]);
  const identify = (dir: string) => {
    sh(dir, "config", "user.name", "Queue Test");
    sh(dir, "config", "user.email", "queue@example.com");
  };
  identify(work);
  const fork = commit("init", {
    "pnpm-lock.yaml": "lock\n",
    "c.ts": "c\n",
    "migrations/0001_init.sql": "CREATE TABLE a;\n",
    "migrations/journal": "0001_init\n",
  });
  const branch = (name: string, files: Record<string, string>) => {
    sh(work, "checkout", "--quiet", "-b", name, fork);
    const sha = commit(name, files);
    sh(work, "checkout", "--quiet", "main");
    return sha;
  };
  const heads = {
    1: branch("topic/1", { "b.ts": "b\n", "e2e/new.spec.ts": "test\n" }),
    2: branch("topic/2", { "c.ts": "mine\n" }),
    4: branch("topic/4", { "b.ts": "other\n" }),
    3: branch("topic/3", {
      "migrations/0002_mine.sql": "CREATE TABLE mine;\n",
      "migrations/journal": "0001_init\n0002_mine\n",
    }),
    5: branch("topic/5", { "docs/notes.md": "notes\n" }),
  };
  commit("main moves", {
    "c.ts": "theirs\n",
    "migrations/0002_theirs.sql": "CREATE TABLE theirs;\n",
    "migrations/journal": "0001_init\n0002_theirs\n",
  });
  sh(work, "remote", "add", "origin", origin);
  sh(work, "push", "--quiet", "origin", "main", ...Object.keys(heads).map((n) => `topic/${n}`));
  sh(root, "clone", "--quiet", origin, clone);
  identify(clone);
  const ran: string[][] = [];
  const asked: { args: string[]; input?: string }[] = [];
  const lines: string[] = [];
  const records: SignOff[] = [];
  let sleeps = 0;
  const fake: Exec = (command, args, options) => {
    if (command === "sh" && args[1]?.startsWith("node select.ts")) {
      ran.push(["select", ...args.slice(3)]);
      return { status: 0, stdout: selected, stderr: "" };
    }
    if (command !== "gh") return shell(command, args, options);
    asked.push({ args, input: options?.input });
    if (args.includes("--method")) return { status: status ? 0 : 1, stdout: "", stderr: "no" };
    if (args[1] === "merge" && !args.includes("--disable-auto"))
      return { status: refuse === undefined ? 0 : 1, stdout: "", stderr: refuse ?? "" };
    const answers = gh[args.slice(0, 2).join(" ")];
    return { status: 0, stdout: answers?.shift() ?? "", stderr: "" };
  };
  const config = parseConfig({
    configVersion: 1,
    gate: {
      ...gate,
      checks: {
        checks: { run: "pnpm verify" },
        web: {
          run: "pnpm e2e:spec --build",
          select: "node select.ts",
          tries: 2,
          timeout: "TIMEOUT_E2E",
        },
      },
    },
    merge,
  });
  const checks: Check[] = Object.entries(config.gate.checks).map(([name, check]) =>
    commandCheck(name, check as Parameters<typeof commandCheck>[1], fake),
  );
  const checkLogs = mkdtempSync(join(tmpdir(), "factory-run-"));
  const deps = queueCheckout({
    dir: clone,
    runDir: root,
    checkLogs,
    checks,
    gate: config.gate,
    merge: config.merge,
    fixups: config.merge.fixups.map((fixup) => commandFixup(fixup as string, fake)),
    machine: timeout ? { TIMEOUT_E2E: timeout } : {},
    record: (signOff) => records.push(signOff),
    log: (line) => lines.push(line),
    sleep: async () => {
      sleeps++;
    },
    sh: fake,
    run: async (given, logFile, _cwd, timeoutMs) => {
      ran.push([...given]);
      const ended = (passed: boolean) => ({ passed, timedOut: false });
      const command = given[0] === "sh" ? given[2]! : given.join(" ");
      if (command.startsWith("pnpm e2e:spec")) {
        writeFileSync(logFile, "running\n");
        if (!slow) return ended(true);
        await new Promise((done) => setTimeout(done, timeoutMs));
        return { passed: false, timedOut: true };
      }
      if (given[1] === "push") {
        writeFileSync(logFile, push.output);
        return ended(push.ok);
      }
      if (command.startsWith("pnpm install")) return ended(install);
      return ended(true);
    },
  });
  const pr = (number: keyof typeof heads): Pr => ({
    number,
    title: `PR ${number}`,
    url: "",
    headRefName: `topic/${number}`,
    headRefOid: heads[number],
    enabledAt: "",
    labels: [],
  });
  return {
    deps,
    checks,
    checkLogs,
    records,
    sleeps: () => sleeps,
    work,
    clone,
    pr,
    ran,
    asked,
    lines,
    show: (sha: string, path: string) => shell("git", ["show", `${sha}:${path}`], { cwd: clone }),
    status: () => sh(clone, "status", "--porcelain"),
  };
}

export const built = (result: Built | { conflict: string }) => {
  assert.ok(!("conflict" in result), "conflict" in result ? result.conflict : "");
  return result;
};
