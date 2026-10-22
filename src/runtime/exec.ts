import { spawnSync } from "node:child_process";

/** Runs a command to completion; tests pass a fake one instead. */
export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string },
) => { status: number | null; stdout: string; stderr: string };

export const exec: Exec = (command, args, { cwd, input } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    // A long `git diff` or `gh pr list` can run past the 1 MB default.
    maxBuffer: 64 * 2 ** 20,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error?.message ?? ""),
  };
};
