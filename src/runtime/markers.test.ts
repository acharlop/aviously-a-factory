import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { exec } from "./exec.ts";
import { gitMarkers, markerOf, passCovering } from "./markers.ts";

test("a check's marker lives in the checkout's git directory, and reads back trimmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-markers-"));
  exec("git", ["init", "--quiet", dir]);
  const markers = gitMarkers(exec, dir);
  assert.equal(markers.read(markerOf("checks")), undefined);
  markers.write(markerOf("checks"), "abc tree1");
  assert.ok(existsSync(join(dir, ".git", "factory-passed-checks")));
  assert.equal(markers.read(markerOf("checks")), "abc tree1");
});

test("a pass covers the commit it names, and a commit with the tree of a step it records", () => {
  const git = (_: string, args: string[]) =>
    args[1] === "step^{tree}"
      ? { status: 0, stdout: "tree2\n", stderr: "" }
      : { status: 128, stdout: "", stderr: "unknown revision" };
  assert.equal(passCovering(undefined, "abc", git), undefined);
  assert.equal(passCovering("abc", "abc", git), "abc");
  assert.equal(passCovering("abc", "step", git), undefined);
  assert.equal(passCovering("abc tree1 tree2", "step", git), "abc");
  assert.equal(passCovering("abc tree1 tree2", "gone", git), undefined);
});
