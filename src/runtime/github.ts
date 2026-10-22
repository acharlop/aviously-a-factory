import { hostname } from "node:os";

import { exec, type Exec } from "./exec.ts";

/** Runs gh and returns what it prints, trimmed; throws with gh's own error when it fails. */
export function gh(args: string[], sh: Exec = exec, input?: string): string {
  const result = sh("gh", args, input === undefined ? {} : { input });
  if (result.status !== 0)
    throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Runs gh and parses what it prints. */
export const ghJson = <T>(args: string[], sh: Exec = exec): T => JSON.parse(gh(args, sh)) as T;

/** owner/name of the repo this checkout's gh points at. */
export const repoName = (sh: Exec = exec) =>
  ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], sh).nameWithOwner;

/** This machine as the factory names it everywhere, as `hostname -s` does: `studio`, `Office-Mac`. */
export const machine = (host = hostname()) => host.split(".")[0]!;

/** The person this machine works for: the gh login. */
export const person = (sh: Exec = exec) => gh(["api", "user", "--jq", ".login"], sh);

/** The person @ the machine, lowercased, as memo titles name them. */
export const who = (sh: Exec = exec, host = hostname()) =>
  `${person(sh)}@${machine(host).toLowerCase()}`;

/** A GraphQL query's data. */
export function graphql<T>(query: string, vars: Record<string, string | number>, sh: Exec = exec) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(vars))
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  return ghJson<{ data: T }>(args, sh).data;
}

function search<T>(on: "Issue" | "PullRequest", search: string, fields: string, sh: Exec): T[] {
  const query = `query($q: String!, $endCursor: String) {
    search(type: ISSUE, query: $q, first: 100, after: $endCursor) {
      nodes { ... on ${on} { ${fields} } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const pages = ghJson<{ data: { search: { nodes: T[] } } }[]>(
    ["api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`, "-f", `q=${search}`],
    sh,
  );
  return pages.flatMap((page) => page.data.search.nodes);
}

/** Every issue an issue search finds, each with the GraphQL fields asked for; a pull request it finds comes back empty. */
export const searchIssues = <T>(query: string, fields: string, sh: Exec = exec): T[] =>
  search<T>("Issue", query, fields, sh);

/** Every pull request an issue search finds, each with the GraphQL fields asked for. */
export const searchPullRequests = <T>(query: string, fields: string, sh: Exec = exec): T[] =>
  search<T>("PullRequest", query, fields, sh);
