import type { Exec } from "../runtime/exec.ts";
import { gh, ghJson, person, repoName } from "../runtime/github.ts";

export type Comment = { id: number; html_url: string; user: { login: string } };

/** The last comment `login` wrote, from the pages `gh api --paginate --slurp` prints, oldest first. */
export const lastOwnComment = (pages: readonly Comment[][], login: string) =>
  pages.flat().findLast((comment) => comment.user.login === login);

/** Replaces the body of this gh login's last comment on an issue or pull request, and gives its URL. */
export function editLast(kind: string, number: number, body: string, sh: Exec): string {
  const repo = repoName(sh);
  const login = person(sh);
  // A pull request's conversation comments live on its issue.
  const pages = ghJson<Comment[][]>(
    ["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments`],
    sh,
  );
  const comment = lastOwnComment(pages, login);
  if (!comment) throw new Error(`${login} has no comment on ${kind} ${number}`);
  gh(
    [
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${comment.id}`,
      "--input",
      "-",
      "--silent",
    ],
    sh,
    JSON.stringify({ body }),
  );
  return comment.html_url;
}
