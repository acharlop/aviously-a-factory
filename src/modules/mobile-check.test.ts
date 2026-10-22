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
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseConfig } from "../config/load.ts";
import { type CheckRun, projectChecks } from "../runtime/checks.ts";
import { exec, type Exec } from "../runtime/exec.ts";
import { runLogged, type Runner } from "../runtime/run.ts";
import { describeFlows, flowResults, mobileCheck } from "./mobile-check.ts";
import type { Mobile } from "./schema.ts";

const run: Runner = (command, logFile, cwd, timeoutMs) =>
  runLogged(command, logFile, cwd, undefined, timeoutMs);

/** A project on main with a mobile app and a branch off it, whose device commands are scripts that note each call in `steps` and answer as a test sets them. */
function project({ machine = { MOBILE_SIGNOFF: "on" } as Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-mobile-check-"));
  const dir = join(root, "work");
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  const sh: Exec = (command, args, options) => exec(command, args, { cwd: dir, ...options });
  const git = (...args: string[]) => sh("git", args).stdout.trim();
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (file: string, text = `${file}\n`) => {
    write(file, text);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  /** Sets what a device command prints and exits with. */
  const answer = (name: string, output = "", status = 0) => {
    const script = join(bin, name);
    writeFileSync(
      script,
      `#!/bin/sh\necho "${name} $*" >> ${join(root, "steps")}\nprintf '${output}'\nexit ${status}\n`,
    );
    chmodSync(script, 0o755);
    return script;
  };
  mkdirSync(dir);
  git("init", "-q", "-b", "main");
  commit("apps/mobile/package.json", "{}");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "topic");
  const mobile: Mobile = {
    department: "mobile",
    app: "apps/mobile",
    native: ["apps/mobile/ios/**"],
    startDevice: answer("start"),
    buildDevice: answer("build"),
    stopDevice: answer("stop"),
    listFlows: answer("list"),
    runFlows: answer("flows"),
  };
  const modules = { translations: "none", screenshots: "none", mobile } as const;
  const check = (cleanup = run) =>
    mobileCheck("mobile", { root: dir, modules, machine, home, sh }, cleanup);
  const lines: string[] = [];
  const at = (sha: string, units: string[], attempt = 0, runner = run): CheckRun => ({
    dir,
    base,
    sha,
    units,
    attempt,
    logFile: join(root, `mobile-${attempt}.log`),
    timeoutMs: 60_000,
    run: runner,
    log: (line) => lines.push(line),
  });
  const steps = () => {
    const file = join(root, "steps");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.trimEnd())
      : [];
  };
  const built = () => JSON.parse(readFileSync(join(home, "dev-build"), "utf8")) as object;
  return { dir, base, home, commit, answer, check, at, steps, lines, built };
}

test("a change needs the flows listFlows prints for its base, none when it prints none, and a refusal when listing fails", async () => {
  const { dir, base, answer, check } = project();
  const change = { dir, base, head: "HEAD", files: undefined };
  answer("list", "chat\\nsign-in\\n");
  assert.deepEqual(await check().needs(change), { units: ["chat", "sign-in"] });
  answer("list");
  assert.equal(await check().needs(change), undefined);
  answer("list", "", 1);
  assert.match(
    ((await check().needs(change)) as { refused: string }).refused,
    /listing the flows mobile runs failed/,
  );
});

test("only the device machine runs the check, and its status names the flows that passed", () => {
  assert.match(project({ machine: {} }).check().unavailable!()!, /MOBILE_SIGNOFF=on/);
  assert.equal(project().check().unavailable!(), undefined);
  assert.equal(describeFlows([]), "no flow reached");
  assert.equal(describeFlows(["sign-in", "chat"]), "flows passed: sign-in, chat");
  assert.equal(describeFlows(Array(40).fill("deliver-stop")).length, 140);
});

test("the flows run between a device check and its stop, each failed one named with where it failed and each unnamed one not run", async () => {
  const { commit, answer, check, at, steps, lines } = project();
  const sha = commit("apps/mobile/src/a.ts");
  answer("flows", "passed chat\\nfailed sign-in: tap Send (e2e/sign-in.ts:12)\\n", 1);
  assert.deepEqual(await check().run(at(sha, ["chat", "sign-in", "stats"])), {
    failed: ["sign-in"],
    notRun: ["stats"],
  });
  assert.deepEqual(steps(), ["stop", "start", "flows chat sign-in stats", "stop"]);
  assert.deepEqual(lines, ["mobile: sign-in failed at tap Send (e2e/sign-in.ts:12)"]);
  answer("flows");
  assert.deepEqual(await check().run(at(sha, ["chat"])), { failed: [] });
});

test("a run log reads passed and failed lines and nothing else", () => {
  assert.deepEqual(
    flowResults("e2e: 2 flows\npassed chat\nfailed stats: wait for Today\nfailed x\n"),
    {
      passed: ["chat"],
      failed: [{ flow: "stats", at: "wait for Today" }, { flow: "x" }],
    },
  );
});

test("a native change builds a new dev build on the first run alone and records the commit it came from", async () => {
  const { commit, check, at, steps, lines, built } = project();
  const sha = commit("apps/mobile/ios/Podfile");
  await check().run(at(sha, ["chat"]));
  assert.deepEqual(built(), { sha });
  await check().run(at(sha, ["chat"], 1));
  assert.deepEqual(steps(), [
    "stop",
    "build",
    "flows chat",
    "stop",
    "stop",
    "start",
    "flows chat",
    "stop",
  ]);
  assert.deepEqual(lines, ["mobile: building a new dev build first: apps/mobile/ios/Podfile"]);
});

test("a dev build recorded from a commit with a native change against this one, or one that didn't finish, is rebuilt; with none recorded, the installed one is trusted", async () => {
  const stale = project();
  const native = stale.commit("apps/mobile/ios/Podfile");
  mkdirSync(stale.home, { recursive: true });
  writeFileSync(join(stale.home, "dev-build"), JSON.stringify({ sha: native }));
  const js = stale.commit("apps/mobile/src/a.ts");
  await stale.check().run(stale.at(js, ["chat"], 1));
  assert.equal(stale.steps()[1], "start", "the native commit's build runs a JS change on it");
  await stale.check().run(stale.at(stale.base, ["chat"], 1));
  assert.equal(stale.steps()[5], "build", "but not the base, from before the native change");

  const failed = project();
  failed.answer("build", "build: Xcode failed\\n", 1);
  const sha = failed.commit("apps/mobile/ios/Podfile");
  assert.deepEqual(await failed.check().run(failed.at(sha, ["chat"])), {
    unavailable: "build: Xcode failed",
  });
  assert.deepEqual(failed.built(), {});
  failed.answer("build");
  await failed.check().run(failed.at(sha, ["chat"], 1));
  assert.equal(failed.steps()[4], "build", "a build that didn't finish is built again");

  const trusted = project();
  await trusted.check().run(trusted.at(trusted.commit("apps/mobile/src/a.ts"), ["chat"]));
  assert.equal(trusted.steps()[1], "start");
});

test("a device check that won't start, or flows that name none, are unavailable with what they said last, and the device is still stopped", async () => {
  const held = project();
  held.answer("start", "start: creating\\nstart: /Users/avi/app holds iPhone 17 Pro.\\n", 1);
  const sha = held.commit("apps/mobile/src/a.ts");
  assert.deepEqual(await held.check().run(held.at(sha, ["chat"])), {
    unavailable: "start: /Users/avi/app holds iPhone 17 Pro.",
  });
  assert.deepEqual(held.steps(), ["stop", "start", "stop"]);

  const silent = project();
  silent.answer("flows", "e2e: no device check running\\n", 1);
  assert.deepEqual(
    await silent.check().run(silent.at(silent.commit("apps/mobile/src/a.ts"), ["chat"])),
    { unavailable: "e2e: no device check running" },
  );
});

test("a signal that stops the flows still stops the device check, through a runner the signal doesn't cancel", async () => {
  const { commit, check, at, steps } = project();
  const sha = commit("apps/mobile/src/a.ts");
  let stopped = false;
  const guarded: Runner = async (command, ...rest) => {
    if (stopped) throw new Error("stopped by SIGTERM");
    const result = await run(command, ...rest);
    stopped = command.join(" ").includes("flows");
    if (stopped) throw new Error("stopped by SIGTERM");
    return result;
  };
  await assert.rejects(check().run(at(sha, ["chat"], 0, guarded)), /stopped by SIGTERM/);
  assert.deepEqual(steps(), ["stop", "start", "flows chat", "stop"]);
});

const config = (modules: object, checks: object) =>
  parseConfig({ configVersion: 1, modules, gate: { checks } });

test("gate.checks names the mobile module's check only with the module on, and a `when` narrows what reaches it", async () => {
  const { dir, base, answer } = project();
  assert.throws(
    () => config({}, { mobile: { module: "mobile" } }),
    /the mobile module is none; switch it on in modules.mobile/,
  );
  const listFlows = answer("list", "chat\\n");
  const on = {
    mobile: {
      app: "a",
      startDevice: "s",
      buildDevice: "b",
      stopDevice: "x",
      listFlows,
      runFlows: "f",
    },
  };
  const parsed = config(on, { flows: { module: "mobile", when: ["apps/mobile/**"] } });
  assert.deepEqual(parsed.gate.checks, { flows: { module: "mobile", when: ["apps/mobile/**"] } });
  const [flows] = projectChecks(parsed.gate, {
    root: dir,
    modules: parsed.modules,
    machine: {},
    home: dir,
    sh: exec,
  });
  assert.equal(flows!.name, "flows");
  assert.equal(flows!.tries, 3);
  const change = (files: string[]) => ({ dir, base, head: "HEAD", files });
  assert.equal(await flows!.needs(change(["apps/web/a.ts"])), undefined);
  assert.deepEqual(await flows!.needs(change(["apps/mobile/a.ts"])), { units: ["chat"] });
});
