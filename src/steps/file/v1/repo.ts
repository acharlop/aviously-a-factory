import type { Exec } from "../../../runtime/exec.ts";
import { gh, ghJson } from "../../../runtime/github.ts";

type Content = { content: string; sha: string };

/** A file in `repo`'s default branch, or undefined when it isn't there yet. */
export function readFile(repo: string, path: string, sh: Exec): Content | undefined {
  const result = sh("gh", ["api", `repos/${repo}/contents/${path}`]);
  if (result.status !== 0) {
    if (/Not Found|404/.test(result.stderr + result.stdout)) return undefined;
    throw new Error(`gh api ${path}: ${result.stderr.trim()}`);
  }
  const file = JSON.parse(result.stdout) as Content & { encoding: string };
  // Over 1 MB the contents API leaves `content` empty; the blob API still has it.
  const { content, encoding } =
    file.encoding === "base64"
      ? file
      : ghJson<{ content: string; encoding: string }>(
          ["api", `repos/${repo}/git/blobs/${file.sha}`],
          sh,
        );
  if (encoding !== "base64") throw new Error(`gh api ${path}: content came back as ${encoding}`);
  return { content: Buffer.from(content, "base64").toString("utf8"), sha: file.sha };
}

/** Commits what `build` makes of the file's current text; on a 409 (someone wrote it since) reads it again and retries once. Returns the text written. */
export function saveFile(
  repo: string,
  path: string,
  build: (current: string) => string,
  message: string,
  sh: Exec,
  retried = false,
): string {
  const current = readFile(repo, path, sh);
  const text = build(current?.content ?? "");
  const body = JSON.stringify({
    message,
    content: Buffer.from(text).toString("base64"),
    ...(current && { sha: current.sha }),
  });
  try {
    gh(["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "--input", "-"], sh, body);
  } catch (error) {
    if (retried || !/\b409\b/.test(String(error))) throw error;
    return saveFile(repo, path, build, message, sh, true);
  }
  return text;
}
