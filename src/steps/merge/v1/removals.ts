import type { Merge } from "../../../config/schema.ts";
import { matches } from "../../../runtime/checks.ts";
import type { Exec } from "../../../runtime/exec.ts";
import type { Pr, Reason } from "./queue.ts";

/** What a pull request removes since it forked from main that the project guards: root package.json scripts, and files its globs match. */
export type Removals = { scripts: readonly string[]; files: readonly string[]; label: string };

/** The script names in before's package.json that after's no longer has. */
export function removedScripts(before: string, after: string): string[] {
  const scripts = (json: string) => {
    try {
      return Object.keys((JSON.parse(json) as { scripts?: object }).scripts ?? {});
    } catch {
      return [];
    }
  };
  const kept = new Set(scripts(after));
  return scripts(before).filter((name) => !kept.has(name));
}

/** What head removes since it forked from main, read in cwd's clone, which has both commits; throws when git can't say. */
export function removals(
  sh: Exec,
  cwd: string,
  head: string,
  main: string,
  guard: Merge["removals"],
): Removals {
  const git = (...args: string[]) => {
    const result = sh("git", args, { cwd });
    if (result.status !== 0)
      throw new Error(`checking removals: git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const guarded = (path = "") => matches(path, guard.files);
  const fork = git("merge-base", head, main).trim();
  // A rename out of the guarded files disables the file as surely as deleting it; -M so a clone's diff.renames can't change that.
  const files =
    guard.files.length === 0
      ? []
      : git("diff", "--name-status", "-M", "--diff-filter=DR", `${fork}..${head}`)
          .split("\n")
          .map((line) => line.split("\t"))
          .filter(([status, from, to]) => guarded(from) && (status === "D" || !guarded(to)))
          .map(([, from]) => from!);
  const pkg = (sha: string) => git("show", `${sha}:package.json`);
  const scripts = guard.scripts ? removedScripts(pkg(fork), pkg(head)) : [];
  return { scripts, files, label: guard.label };
}

/** Why the queue drops a pull request for what it removes, or undefined when it removes nothing guarded or carries the label that allows it. */
export function removalRefusal(pr: Pr, { scripts, files, label }: Removals): Reason | undefined {
  if (pr.labels.includes(label) || (scripts.length === 0 && files.length === 0)) return undefined;
  return {
    summary: `it removes ${[scripts.length > 0 && "a root script", files.length > 0 && "a guarded file"].filter(Boolean).join(" and ")}, which needs a ticket line that asks for it`,
    next: `To land it, the foreman adds the \`${label}\` label once quality control explains it, and turns auto-merge back on.`,
    details: [
      ...scripts.map((name) => `removed script: ${name}`),
      ...files.map((path) => `deleted: ${path}`),
    ],
  };
}

/** The dry run's line for a pull request the removal guard would drop, naming what it removes; undefined when it would pass. */
export function removalPreview(pr: Pr, removes: Removals): string | undefined {
  const refusal = removalRefusal(pr, removes);
  return refusal && `would be dropped: ${refusal.summary} (${(refusal.details ?? []).join("; ")})`;
}
