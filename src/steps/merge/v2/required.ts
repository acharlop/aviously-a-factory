import { exec, type Exec } from "../../../runtime/exec.ts";

/** The status checks GitHub requires before a pull request merges into a branch, and whether it must be up to date with the branch first. */
export type Required = { checks: string[]; strict: boolean };

type Rule = {
  type: string;
  parameters?: {
    strict_required_status_checks_policy?: boolean;
    required_status_checks?: { context: string }[];
  };
};

type Protection = { strict?: boolean; contexts?: string[] };

/** `gh api <path>`'s answer, or undefined when GitHub says there is nothing there. */
function read<T>(path: string, sh: Exec): T | undefined {
  const result = sh("gh", ["api", path]);
  if (result.status === 0) return JSON.parse(result.stdout) as T;
  if (/HTTP 404|not found|not protected/i.test(result.stderr)) return undefined;
  throw new Error(`gh api ${path}: ${result.stderr.trim()}`);
}

/** The base branch's required checks, from its rulesets and its branch protection together. */
export function requiredChecks(base: string, sh: Exec = exec, repo = "{owner}/{repo}"): Required {
  const rules = (read<Rule[]>(`repos/${repo}/rules/branches/${base}`, sh) ?? []).filter(
    (rule) => rule.type === "required_status_checks",
  );
  const protection = read<Protection>(
    `repos/${repo}/branches/${base}/protection/required_status_checks`,
    sh,
  );
  const checks = [
    ...rules
      .flatMap(({ parameters }) => parameters?.required_status_checks ?? [])
      .map((c) => c.context),
    ...(protection?.contexts ?? []),
  ];
  return {
    checks: [...new Set(checks)],
    strict:
      rules.some(({ parameters }) => parameters?.strict_required_status_checks_policy) ||
      Boolean(protection?.strict),
  };
}
