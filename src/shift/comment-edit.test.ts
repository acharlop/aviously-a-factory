import assert from "node:assert/strict";
import { test } from "node:test";

import type { Exec } from "../runtime/exec.ts";
import { editLast, lastOwnComment } from "./comment-edit.ts";

const comment = (id: number, login: string) => ({
  id,
  html_url: `https://github.com/o/app/issues/866#issuecomment-${id}`,
  user: { login },
});

test("the last comment is this login's latest across every page, whoever wrote after it", () => {
  const pages = [
    [comment(1, "avi"), comment(2, "nati")],
    [comment(3, "avi"), comment(4, "github-actions[bot]")],
  ];
  assert.equal(lastOwnComment(pages, "avi")?.id, 3);
  assert.equal(lastOwnComment(pages, "someone"), undefined);
});

test("the edit patches that comment with the new body as JSON", () => {
  const calls: { args: string[]; input?: string }[] = [];
  const sh: Exec = (_command, args, options) => {
    calls.push({ args, ...(options?.input !== undefined && { input: options.input }) });
    const out = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "repo") return out('{"nameWithOwner":"o/app"}');
    if (args[1] === "user") return out("avi\n");
    if (args.includes("--slurp"))
      return out(JSON.stringify([[comment(7, "avi"), comment(8, "nati")]]));
    return out("");
  };
  const url = editLast("pr", 866, "Fixed: [#12 📋](https://x/issues/12)", sh);
  assert.equal(url, "https://github.com/o/app/issues/866#issuecomment-7");
  assert.deepEqual(calls.at(-1), {
    args: ["api", "-X", "PATCH", "repos/o/app/issues/comments/7", "--input", "-", "--silent"],
    input: '{"body":"Fixed: [#12 📋](https://x/issues/12)"}',
  });
});
