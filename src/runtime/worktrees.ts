export type Worktree = { path: string; head: string; branch: string | undefined };

/** The worktrees `git worktree list --porcelain` prints, the main checkout first; a detached or bare one has no branch. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const found: Worktree[] = [];
  for (const block of porcelain.trim().split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    found.push({
      path,
      head: /^HEAD (\w+)$/m.exec(block)?.[1] ?? "",
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
    });
  }
  return found;
}

/** The ticket's working branch, `<department>/<n>-<slug>`, never a parked one or another number's. */
export function workingBranch(branches: readonly string[], number: number): string | undefined {
  const own = new RegExp(`^(?!park/)[^/]+/${number}-.`);
  return branches.find((branch) => own.test(branch));
}
