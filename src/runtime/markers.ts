import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Exec } from "./exec.ts";

/** The file in the git directory whose first word is the commit the check last passed on, followed by the trees that pass covers. */
export const markerOf = (check: string) => `factory-passed-${check}`;

export type Markers = {
  read: (marker: string) => string | undefined;
  write: (marker: string, content: string) => void;
};

/** The markers in the git directory of the checkout at cwd. */
export function gitMarkers(git: Exec, cwd = "."): Markers {
  const path = (marker: string) =>
    resolve(cwd, git("git", ["rev-parse", "--git-path", marker], { cwd }).stdout.trim());
  return {
    read: (marker) => {
      const file = path(marker);
      return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
    },
    write: (marker, content) => writeFileSync(path(marker), `${content}\n`),
  };
}

/** The commit whose recorded pass covers sha: the one the record names when it's sha, or a test branch tip when sha has the tree of one of its steps, so the check ran on exactly sha's code. */
export function passCovering(
  record: string | undefined,
  sha: string,
  git: Exec,
  cwd?: string,
): string | undefined {
  const [ran, ...trees] = record?.split(/\s+/) ?? [];
  if (!ran) return undefined;
  if (ran === sha) return ran;
  if (trees.length === 0) return undefined;
  const tree = git("git", ["rev-parse", `${sha}^{tree}`], { cwd });
  return tree.status === 0 && trees.includes(tree.stdout.trim()) ? ran : undefined;
}
