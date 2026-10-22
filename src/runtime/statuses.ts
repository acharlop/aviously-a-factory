import type { Exec } from "./exec.ts";

function post(
  sh: Exec,
  sha: string,
  context: string,
  fields: string[],
  cwd?: string,
): string | undefined {
  const status = [`repos/{owner}/{repo}/statuses/${sha}`, "-f", `context=${context}`];
  const flags = fields.flatMap((field) => ["-f", field]);
  const posted = sh("gh", ["api", "--method", "POST", ...status, ...flags], { cwd });
  return posted.status === 0 ? undefined : `posting ${context} failed: ${posted.stderr.trim()}`;
}

/** Posts each check's status as passed on sha, under prefix and with its description; why not, at the first that fails. */
export function postPassed(
  sh: Exec,
  sha: string,
  prefix: string,
  checks: readonly { name: string; description: string }[],
  cwd?: string,
): string | undefined {
  for (const { name, description } of checks) {
    const fields = ["state=success", `description=${description}`];
    const failed = post(sh, sha, `${prefix}${name}`, fields, cwd);
    if (failed) return failed;
  }
  return undefined;
}

/** Posts the check's status as failed on sha, linked to its sign-off when there is one; why not, when it fails. */
export function postFailed(
  sh: Exec,
  sha: string,
  context: string,
  description: string,
  url?: string,
  cwd?: string,
): string | undefined {
  const link = url ? [`target_url=${url}`] : [];
  return post(sh, sha, context, ["state=failure", `description=${description}`, ...link], cwd);
}
