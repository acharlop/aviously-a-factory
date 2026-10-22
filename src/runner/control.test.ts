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
import { type Control, HAND, handShift, off, on, plist, plistPath, stop } from "./control.ts";

function fake(loaded = false) {
  const user = mkdtempSync(join(tmpdir(), "factory-user-"));
  const home = join(user, ".factory");
  mkdirSync(home);
  const calls: string[] = [];
  const printed: string[] = [];
  const sh: Exec = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const ok = command === "launchctl" && args[0] === "print" ? loaded : command === "launchctl";
    return { status: ok ? 0 : 1, stdout: "", stderr: "" };
  };
  const c: Control = { home, user, sh, uid: 501, print: (line) => printed.push(line) };
  return { c, user, home, calls, printed };
}

test("the launchd job runs factory runner tick now and every 15 minutes, with this node first on PATH", () => {
  const text = plist({
    node: "/n/v24/bin/node",
    cli: "/p/dist/cli/main.js",
    home: "/u/.factory",
    user: "/u",
  });
  assert.match(
    text,
    /<string>\/n\/v24\/bin\/node<\/string><string>\/p\/dist\/cli\/main.js<\/string><string>runner<\/string><string>tick<\/string>/,
  );
  assert.match(text, /<key>PATH<\/key><string>\/n\/v24\/bin:\/u\/.local\/bin:/);
  assert.match(text, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(text, /<string>\/u\/.factory\/runner\/launchd.log<\/string>/);
  assert.equal(plistPath("/u"), "/u/Library/LaunchAgents/aviously-a-factory.runner.plist");
});

test("on needs the Claude token, the saved job and a project before it loads anything", () => {
  const { c, home, user, calls, printed } = fake();
  assert.equal(on(c), 1);
  assert.match(printed.at(-1)!, /pbpaste > .*claude-token && chmod 600/);
  writeFileSync(join(home, "claude-token"), "t");
  chmodSync(join(home, "claude-token"), 0o600);
  assert.equal(on(c), 1);
  assert.match(
    printed.at(-1)!,
    /Save it first: factory runner plist > .*aviously-a-factory.runner.plist/,
  );
  mkdirSync(join(user, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(user), "<plist/>");
  assert.equal(on(c), 1);
  assert.match(printed.at(-1)!, /No PROJECTS/);
  assert.deepEqual(calls, []);
  writeFileSync(join(home, "machine"), "PROJECTS=a\n");
  mkdirSync(join(home, "runner"));
  writeFileSync(join(home, "runner", "stopping"), "");
  assert.equal(on(c), 0);
  assert.equal(existsSync(join(home, "runner", "stopping")), false);
  assert.deepEqual(calls, [
    "launchctl bootout gui/501/aviously-a-factory.runner",
    `launchctl bootstrap gui/501 ${plistPath(user)}`,
  ]);
});

test("stop drains a loaded runner and says so; off unloads it", () => {
  const off_ = fake(false);
  assert.equal(stop(off_.c), 0);
  assert.equal(off_.printed[0], "Runner already off.");
  const loaded = fake(true);
  assert.equal(stop(loaded.c), 0);
  assert.equal(existsSync(join(loaded.home, "runner", "stopping")), true);
  assert.equal(off(loaded.c), 0);
  assert.equal(existsSync(join(loaded.home, "runner", "stopping")), false);
  assert.equal(loaded.calls.at(-1), "launchctl bootout gui/501/aviously-a-factory.runner");
});

test("a hand-started shift runs a preset in tmux, holding the runner's lock", () => {
  const { c, home, user, printed } = fake();
  const checkout = join(user, "code", "a");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(home, "a"));
  writeFileSync(join(home, "a", "config"), `CHECKOUT=$HOME/code/a\n`);
  writeFileSync(join(user, "claude"), "");
  writeFileSync(
    join(home, "machine"),
    `PROJECTS=a\nCLAUDE=$HOME/claude\nSHIFT_WEB="unsupervised department:web merged:2"\nSHIFT_NIGHT="lights-out"\n`,
  );
  const tmux: string[][] = [];
  const hand = { ...c, tty: false, attach: (args: string[]) => (tmux.push(args), 0) };
  assert.equal(handShift(hand, []), 2);
  assert.equal(handShift(hand, ["a", "night"]), 2);
  assert.match(printed.at(-1)!, /Lights-out shifts are the runner's/);
  assert.equal(handShift(hand, ["a", "web"]), 1);
  assert.match(printed.at(-1)!, /hasn't trusted/);
  writeFileSync(
    join(user, ".claude.json"),
    JSON.stringify({ projects: { [checkout]: { hasTrustDialogAccepted: true } } }),
  );
  assert.equal(handShift(hand, ["a", "web"]), 0);
  const command = tmux[0]!.at(-1)!;
  assert.deepEqual(tmux[0]!.slice(4, 8), ["new-session", "-d", "-s", "factory"]);
  assert.match(
    command,
    /exec '.*\/claude' --permission-mode auto --remote-control 'shift-[a-z0-9-]+' '\/aviously-a-factory:foreman unsupervised department:web order:priority merged:2'$/,
  );
  assert.equal(readFileSync(join(home, "runner", "lock", "step"), "utf8").trim(), HAND);
});
