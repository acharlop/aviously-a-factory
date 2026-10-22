import assert from "node:assert/strict";
import { test } from "node:test";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Exec } from "../../../runtime/exec.ts";
import type { Filing } from "./record.ts";
import {
  drop,
  entries,
  entryPath,
  readReviews,
  recordReview,
  unreviewed,
} from "./suggestion-box.ts";

const trail: PaperTrail = {
  repo: "o/trail",
  timesheet: "timesheets/shifts.jsonl",
  signOffs: "sign-offs",
  memoLabel: "memo",
  suggestionBox: "box",
};

/** The paper trail's files in memory, through the contents and trees APIs. */
function github(files: Record<string, string> = {}) {
  const sh: Exec = (_, args, { input } = {}) => {
    const ok = (stdout: unknown) => ({ status: 0, stdout: JSON.stringify(stdout), stderr: "" });
    if (args[1]?.includes("/git/trees/"))
      return ok({ tree: Object.keys(files).map((path) => ({ path, type: "blob" })) });
    const path = (args[1] === "-X" ? args[3]! : args[1]!).replace("repos/o/trail/contents/", "");
    if (args[1] !== "-X")
      return path in files
        ? ok({
            content: Buffer.from(files[path]!).toString("base64"),
            encoding: "base64",
            sha: "s",
          })
        : { status: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    files[path] = Buffer.from(JSON.parse(input!).content, "base64").toString();
    return ok("");
  };
  const filing: Filing = {
    trail,
    repo: "o/app",
    project: "app",
    home: "/nowhere",
    stamp: { person: "avi", machine: "studio", step: "file@1", factory: "0.1.0", steps: [] },
    sh,
  };
  return { sh, files, filing };
}

const at = new Date(2026, 9, 14, 9, 5);

test("a shift's notes land in a folder per day, stamped, named to sort in the order they were dropped", () => {
  const { files, filing } = github();
  const path = drop("- the queue dropped #12: a flaky spec\n", filing, at);
  assert.equal(path, "box/2026-10-14/0905-studio-shift0.md");
  assert.equal(entryPath(trail, at, "studio", 7), "box/2026-10-14/0905-studio-shift7.md");
  assert.equal(
    files[path],
    "<!-- avi on studio, shift 0, file@1, factory 0.1.0 -->\n\n- the queue dropped #12: a flaky spec\n",
  );
});

test("a review records what it read through, and the next lists only the entries dropped after it", () => {
  const { sh, files, filing } = github({
    "box/2026-10-13/2200-studio-shift6.md": "a",
    "box/2026-10-14/0905-studio-shift7.md": "b",
    "box/2026-10-14/1100-office-shift2.md": "c",
    "box/reviews.jsonl": "",
    "timesheets/shifts.jsonl": "",
  });
  const all = entries(trail, sh);
  assert.deepEqual(all, [
    "box/2026-10-13/2200-studio-shift6.md",
    "box/2026-10-14/0905-studio-shift7.md",
    "box/2026-10-14/1100-office-shift2.md",
  ]);
  assert.deepEqual(unreviewed(all, []), all);
  recordReview(
    "box/2026-10-14/0905-studio-shift7.md",
    ["https://github.com/o/app/pull/9"],
    filing,
    at,
  );
  const reviews = readReviews(trail, sh);
  assert.deepEqual(
    reviews.map(({ person, machine, step, through, prs }) => ({
      person,
      machine,
      step,
      through,
      prs,
    })),
    [
      {
        person: "avi",
        machine: "studio",
        step: "file@1",
        through: "box/2026-10-14/0905-studio-shift7.md",
        prs: ["https://github.com/o/app/pull/9"],
      },
    ],
  );
  assert.deepEqual(unreviewed(all, reviews), ["box/2026-10-14/1100-office-shift2.md"]);
  assert.equal(files["box/reviews.jsonl"]!.split("\n").length, 2);
});
