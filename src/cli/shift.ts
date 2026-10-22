import { existsSync, readFileSync } from "node:fs";

import { loadProject } from "../config/load.ts";
import { exec, type Exec } from "../runtime/exec.ts";
import { repoName } from "../runtime/github.ts";
import { FACTORY_HOME, machineConfig } from "../runtime/machine.ts";
import { marksFile, readMarks, STEPS, type Step } from "../runtime/marks.ts";
import { currentSession, projectDir, readShift, totals } from "../runtime/transcripts.ts";
import { bashGroups, callsReport, heavy, readCalls } from "../shift/calls.ts";
import { clean as cleanWorktrees } from "../shift/clean.ts";
import { editLast } from "../shift/comment-edit.ts";
import { epicClose as closeEpic } from "../shift/epic-close.ts";
import { stopE2e as stopLeftovers } from "../shift/stop-e2e.ts";
import { mark, newlyOverdue, timingsReport } from "../shift/timings.ts";
import { printShift, usageReport } from "../shift/usage.ts";

const project = (sh: Exec) => repoName(sh).split("/")[1]!;

/** `factory clean [--dry-run]`: removes the worktrees and branches of merged pull requests. */
export async function clean(args: string[], sh: Exec = exec): Promise<number> {
  return cleanWorktrees(args, (await loadProject()).foreman.teardown, sh);
}

export const epicClose = async (args: string[]) => closeEpic(args, exec);

/** `factory comment-edit <issue|pr> <n> --body-file <file>`: replaces the body of this gh login's last comment there; `-` reads stdin. */
export async function commentEdit(args: string[], sh: Exec = exec): Promise<number> {
  const [kind, n, flag, file] = args;
  const number = Number(n);
  if (
    args.length !== 4 ||
    (kind !== "issue" && kind !== "pr") ||
    !Number.isInteger(number) ||
    number <= 0 ||
    flag !== "--body-file"
  ) {
    console.log("usage: factory comment-edit <issue|pr> <n> --body-file <file>");
    return 2;
  }
  const body = readFileSync(file === "-" ? 0 : file!, "utf8");
  if (body.trim() === "") {
    console.log("the body is empty; nothing edited");
    return 2;
  }
  console.log(`edited ${editLast(kind, number, body, sh)}`);
  return 0;
}

/** `factory stop-e2e <worktree>`: stops what a stopped agent left running in its worktree. */
export async function stopE2e(args: string[]): Promise<number> {
  const [dir, ...rest] = args;
  if (!dir || rest.length > 0 || !existsSync(dir)) {
    console.log("usage: factory stop-e2e <worktree path>");
    return 2;
  }
  await stopLeftovers({ dir });
  return 0;
}

/** This shift's agents, from its transcripts. */
function runningAgents(marks: ReturnType<typeof readMarks>) {
  const dir = projectDir();
  const session = currentSession(dir);
  return session ? readShift(dir, session, Date.now(), marks).agents : [];
}

const TIMINGS_USAGE = `usage: factory timings [--watch | start|end <${STEPS.join("|")}> [<ticket>]]`;

/**
 * `factory timings`: anything overdue, then each step's median minutes. `start|end <step>` marks
 * one; `--watch` waits until an agent passes its timeout, prints it and exits.
 */
export async function timings(
  args: string[],
  sh: Exec = exec,
  home = FACTORY_HOME,
): Promise<number> {
  const [event, step, key] = args;
  const watch = args.length === 1 && event === "--watch";
  const marking =
    (event === "start" || event === "end") && STEPS.includes(step as Step) && args.length <= 3;
  if (args.length > 0 && !watch && !marking) {
    console.log(TIMINGS_USAGE);
    return 2;
  }
  const name = project(sh);
  const file = marksFile(name, home);
  const config = () => machineConfig(name, home);
  if (args.length === 0) {
    const marks = readMarks(file);
    for (const line of timingsReport(marks, runningAgents(marks), config())) console.log(line);
    return 0;
  }
  if (watch) {
    // Agents already late were reported to the foreman before this watch started.
    const seen = new Set<string>();
    newlyOverdue(runningAgents(readMarks(file)), config(), seen);
    for (;;) {
      await new Promise((done) => setTimeout(done, 60_000));
      const late = newlyOverdue(runningAgents(readMarks(file)), config(), seen);
      if (late.length === 0) continue;
      for (const line of late) console.log(`OVERDUE ${line}`);
      return 0;
    }
  }
  mark(file, step as Step, event as "start" | "end", key);
  return 0;
}

/** `factory usage [<session-id>] [--json]`: each agent's minutes and tokens in the shift, then its totals. */
export async function usage(args: string[], sh: Exec = exec): Promise<number> {
  return printShift(
    args,
    "usage",
    readMarks(marksFile(project(sh))),
    (dir, session, marks) => readShift(dir, session, Date.now(), marks),
    (shift) => ({ ...shift, totals: totals(shift) }),
    usageReport,
  );
}

/** `factory calls [<session-id>] [--json]`: the shift's tool calls, Bash grouped by what it runs, then the slowest and largest. */
export async function calls(args: string[], sh: Exec = exec): Promise<number> {
  const commands = heavy((await loadProject()).foreman.heavy);
  return printShift(
    args,
    "calls",
    readMarks(marksFile(project(sh))),
    readCalls,
    (shift) => ({ ...shift, bash: bashGroups(shift.calls, commands) }),
    (shift) => callsReport(shift, commands),
  );
}
