import { exec, type Exec } from "./exec.ts";
import { ghJson } from "./github.ts";

type Thread = {
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: { nodes: { author: { login: string } | null; body: string }[] };
};

type Page = {
  data: {
    repository: {
      pullRequest: {
        reviewDecision: string | null;
        reviewThreads: { nodes: Thread[] };
      };
    };
  };
};

const QUERY = `query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewDecision
      reviewThreads(first: 100, after: $endCursor) {
        nodes { isResolved path line comments(first: 1) { nodes { author { login } body } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const firstLine = (body: string) => {
  const line = body.trim().split("\n")[0]!.trim();
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

/** What keeps GitHub from merging the pull request whatever its statuses say, one line each: its open review threads, then changes requested; none when review lets it merge. */
export function reviewBlockers(number: number, sh: Exec = exec): string[] {
  const pages = ghJson<Page[]>(
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${QUERY}`,
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      `number=${number}`,
    ],
    sh,
  );
  const blockers = pages
    .flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes)
    .filter(({ isResolved }) => !isResolved)
    .map(({ path, line, comments }) => {
      const first = comments.nodes[0];
      const said = first ? ` by ${first.author?.login ?? "ghost"}: ${firstLine(first.body)}` : "";
      return `open review thread at ${path}${line ? `:${line}` : ""}${said}`;
    });
  if (pages[0]?.data.repository.pullRequest.reviewDecision === "CHANGES_REQUESTED")
    blockers.push("a reviewer requested changes");
  return blockers;
}

/** Why a pull request with review blockers isn't signed off yet. */
export const reviewRefusal = (number: number, blockers: readonly string[]) =>
  `#${number} can't merge until its review is settled; resolve each thread (fix it, or reply and resolve) and clear requested changes first:\n${blockers.map((line) => `  - ${line}`).join("\n")}`;
