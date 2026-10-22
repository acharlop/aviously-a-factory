import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseConfig, resolveConfig } from "../config/load.ts";
import { exec, type Exec } from "../runtime/exec.ts";
import { nativeChanges, notDeviceMachine } from "./mobile.ts";
import type { Mobile } from "./schema.ts";

const MOBILE: Mobile = {
  department: "mobile",
  app: "apps/mobile",
  native: ["apps/mobile/ios/**", "apps/mobile/app.config.*"],
  startDevice: "pnpm device-check",
  stopDevice: "pnpm device-check --stop",
  listFlows: "pnpm e2e --dry-run",
  runFlows: "pnpm e2e --shots",
};

const resolved = (modules: object) =>
  resolveConfig(parseConfig({ configVersion: 1, modules }), "/p");

/** A git repo on main with a mobile app, and a branch to change it on. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "factory-mobile-"));
  const sh: Exec = (command, args, options) => exec(command, args, { cwd: root, ...options });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const commit = () => {
    sh("git", ["add", "."]);
    sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"]);
  };
  sh("git", ["init", "-q", "-b", "main"]);
  write("apps/mobile/package.json", JSON.stringify({ dependencies: { expo: "1.0.0", a: "1" } }));
  write("apps/mobile/src/screen.tsx", "");
  commit();
  sh("git", ["checkout", "-qb", "feature"]);
  return { sh, write, commit };
}

test("a JS-only branch needs no dev build", () => {
  const { sh, write, commit } = repo();
  write("apps/mobile/src/screen.tsx", "export {}");
  commit();
  assert.deepEqual(nativeChanges(MOBILE, "main", "HEAD", sh), []);
});

test("a native file or an added or bumped app dependency needs a new dev build", () => {
  const { sh, write, commit } = repo();
  write("apps/mobile/ios/Podfile", "");
  write("apps/mobile/app.config.ts", "");
  write(
    "apps/mobile/package.json",
    JSON.stringify({ dependencies: { expo: "1.1.0", camera: "2" } }),
  );
  commit();
  assert.deepEqual(nativeChanges(MOBILE, "main", "HEAD", sh), [
    "apps/mobile/app.config.ts",
    "apps/mobile/ios/Podfile",
    "apps/mobile/package.json: expo 1.0.0 → 1.1.0",
    "apps/mobile/package.json: camera added → 2",
  ]);
});

test("a range git can't read is undefined, not an empty list", () => {
  const { sh } = repo();
  assert.equal(nativeChanges(MOBILE, "nope", "HEAD", sh), undefined);
});

test("only a machine with the device role runs device checks, and only with the mobile module on", () => {
  assert.match(notDeviceMachine(resolved({}), { MOBILE_SIGNOFF: "on" })!, /module is none/);
  assert.match(notDeviceMachine(resolved({ mobile: MOBILE }), {})!, /MOBILE_SIGNOFF=on/);
  assert.equal(notDeviceMachine(resolved({ mobile: MOBILE }), { MOBILE_SIGNOFF: "on" }), undefined);
});
