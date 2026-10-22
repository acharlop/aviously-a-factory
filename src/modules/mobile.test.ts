import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { exec, type Exec } from "../runtime/exec.ts";
import { lockedImporter, nativeBetween, nativeChanges, notDeviceMachine } from "./mobile.ts";
import type { Mobile } from "./schema.ts";

const MOBILE: Mobile = {
  department: "mobile",
  app: "apps/mobile",
  native: ["apps/mobile/ios/**", "apps/mobile/app.config.*"],
  startDevice: "pnpm device-check",
  buildDevice: "pnpm device-check --build",
  stopDevice: "pnpm device-check --stop",
  listFlows: "pnpm e2e --dry-run",
  runFlows: "pnpm e2e",
};

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
  const sha = () => sh("git", ["rev-parse", "HEAD"]).stdout.trim();
  sh("git", ["init", "-q", "-b", "main"]);
  write("apps/mobile/package.json", JSON.stringify({ dependencies: { expo: "1.0.0", a: "1" } }));
  write("apps/mobile/src/screen.tsx", "");
  commit();
  sh("git", ["checkout", "-qb", "feature"]);
  return { sh, write, commit, sha };
}

test("a JS-only branch needs no dev build", () => {
  const { sh, write, commit } = repo();
  write("apps/mobile/src/screen.tsx", "export {}");
  commit();
  assert.deepEqual(nativeChanges(MOBILE, "main", "HEAD", sh), []);
});

test("a native file or an app dependency added, bumped or removed needs a new dev build", () => {
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
    "apps/mobile/package.json: a 1 → removed",
  ]);
});

test("a range git can't read is undefined, not an empty list", () => {
  const { sh } = repo();
  assert.equal(nativeChanges(MOBILE, "nope", "HEAD", sh), undefined);
});

const lock = (camera: string, jest = "1.0.0") => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      camera:
        specifier: 9.0.0
        version: 9.0.0

  apps/mobile:
    dependencies:
      camera:
        specifier: ~${camera}
        version: ${camera}(expo@1.0.0)
      expo:
        specifier: 1.0.0
        version: 1.0.0

    devDependencies:
      jest:
        specifier: ${jest}
        version: ${jest}
`;

test("the lockfile importer gives each of the app's dependencies its specifier and version, without the peer suffix", () => {
  assert.deepEqual(
    [...lockedImporter(lock("2.0.1"), "apps/mobile")],
    [
      ["camera", "~2.0.1 2.0.1"],
      ["expo", "1.0.0 1.0.0"],
      ["jest", "1.0.0 1.0.0"],
    ],
  );
});

test("a runtime dependency the lockfile moves needs a new dev build though package.json didn't change; a dev dependency doesn't", () => {
  const { sh, write, commit } = repo();
  write(
    "apps/mobile/package.json",
    JSON.stringify({ dependencies: { expo: "1.0.0", camera: "~2.0.1" } }),
  );
  write("pnpm-lock.yaml", lock("2.0.1"));
  commit();
  sh("git", ["checkout", "-qb", "bump"]);
  write("pnpm-lock.yaml", lock("2.0.4", "2.0.0"));
  commit();
  assert.deepEqual(nativeChanges(MOBILE, "feature", "HEAD", sh), [
    "apps/mobile/package.json: camera ~2.0.1 2.0.1 → ~2.0.4 2.0.4",
  ]);
});

test("between two commits a native change counts in either direction, so a build of a later commit can't run an earlier one", () => {
  const { sh, write, commit, sha } = repo();
  const before = sha();
  write("apps/mobile/app.config.ts", "");
  commit();
  const native = sha();
  write("apps/mobile/src/screen.tsx", "export {}");
  commit();
  assert.deepEqual(nativeBetween(MOBILE, native, sha(), sh), []);
  assert.deepEqual(nativeBetween(MOBILE, sha(), before, sh), ["apps/mobile/app.config.ts"]);
  assert.equal(nativeBetween(MOBILE, "0".repeat(40), sha(), sh), undefined);
});

test("only a machine with the device role runs device checks, and only with the mobile module on", () => {
  assert.match(notDeviceMachine("none", { MOBILE_SIGNOFF: "on" })!, /module is none/);
  assert.match(notDeviceMachine(MOBILE, {})!, /MOBILE_SIGNOFF=on/);
  assert.equal(notDeviceMachine(MOBILE, { MOBILE_SIGNOFF: "on" }), undefined);
});
