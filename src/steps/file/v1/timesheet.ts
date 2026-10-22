import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Exec } from "../../../runtime/exec.ts";
import { graphql, searchIssues, searchPullRequests } from "../../../runtime/github.ts";
import { projectHome } from "../../../runtime/machine.ts";
import { marksFile, readMarks } from "../../../runtime/marks.ts";
import {
  handBack,
  invocation,
  minutes,
  readShift,
  sessionArgs,
  type Shift,
  totals,
} from "../../../runtime/transcripts.ts";
import { type Filing, localDate, type Mode, modeIn, type Stamp } from "./record.ts";
import { readFile, saveFile } from "./repo.ts";

export const RECALL = "recall";
const DECISION_NEEDED = "decision needed";

/** One shift's row. Field names other than the stamp's are the on-disk format older rows share. */
export type Row = Partial<Stamp> & {
  session: string;
  date: string;
  start: string;
  end: string;
  machine: string;
  mode: Mode;
  ticketsIn: number;
  merged: number;
  wallMinutes: number;
  /** The session's exact totals from Claude Code's `cost-state` record, auto-mode classifier calls included. */
  costState: { read: number; written: number; thinking: number; usd: number } | null;
  /** Per-agent breakdown from the transcripts, which leave out the classifier's calls; `lead` is the foreman. */
  transcripts: { leadRead: number; agentsRead: number; leadPeak: number };
  agents?: {
    ticket: string;
    step: string;
    minutes: number;
    turns: number;
    read: number;
    written: number;
    peak: number;
  }[];
  mergedNoFixRound: number;
  fixRounds: number;
  reviewBugs: number;
  queueGreenFirstTry: number;
  queueBatches: number;
  flakes: number;
  drops: number;
  decisionNeeded: number;
  handMerges: number;
  /** Recalls filed since the previous shift. */
  escapes: number;
};

export type QueueStats = {
  batches: number;
  greenFirstTry: number;
  flakes: number;
  drops: number;
  landed: Set<number>;
};

/** A test branch that passed on its first run and landed every PR it started with: no flake, no drop, no starting over. */
function landedAll(batch: string): boolean {
  if (/ failed\b/.test(batch)) return false;
  const started = /^merge-queue: test branch \S+ is main \S+ plus (.*)$/m.exec(batch)?.[1] ?? "";
  const landed = new Set(
    [...batch.matchAll(/^merge-queue: #(\d+) merged(?! outside)/gm)].map(([, n]) => n),
  );
  return [...started.matchAll(/#(\d+)/g)].every(([, n]) => landed.has(n));
}

/** Counts the queue's test branches, the ones green on their first run that landed every PR they started with, flakes and drops between `start` and `end`; `landed` holds every PR the queue merged in the whole log. */
export function queueStats(log: string, start: number, end: number): QueueStats {
  const lines = log.split("\n").map((line) => {
    const [, time, said = line] = /^(\d{4}-\S+Z) (.*)$/.exec(line) ?? [];
    return { at: time ? Date.parse(time) : NaN, said };
  });
  const landed = lines.flatMap(({ said }) => {
    const merged = /^merge-queue: #(\d+) merged(?! outside)/.exec(said);
    return merged ? [Number(merged[1])] : [];
  });
  const inShift = lines.filter(({ at }) => at >= start && at <= end).map(({ said }) => said);
  const count = (prefix: string) => inShift.filter((said) => said.startsWith(prefix)).length;
  const batches = inShift
    .join("\n")
    .split(/^(?=merge-queue: test branch )/m)
    .filter((batch) => batch.startsWith("merge-queue: test branch "));
  return {
    batches: batches.length,
    greenFirstTry: batches.filter(landedAll).length,
    flakes: count("merge-queue: green on retry"),
    drops: count("merge-queue: dropping #"),
    landed: new Set(landed),
  };
}

/** The items listed under a rework report's `Bugs fixed from review:` heading; none when it has no heading. */
export function reviewBugs(report: string): number {
  const lines = report.split("\n");
  const at = lines.findIndex((line) => /^\W*Bugs fixed from review:/i.test(line));
  if (at < 0 || /\w/.test(lines[at]!.split(/review:/i)[1]!)) return 0;
  let count = 0;
  for (const line of lines.slice(at + 1)) {
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) count += 1;
    else if (line.trim() ? !/^\s{2,}/.test(line) : count > 0) break;
  }
  return count;
}

const isRework = (step: string) => /\b(?:fix|rework)\b/i.test(step);

/** The ticket a branch is for: `web/666-timesheet` is 666. */
export const branchTicket = (branch: string) => /^[^/]+\/(\d+)-/.exec(branch)?.[1];

export type MergedPr = { number: number; headRefName: string; mergedAt: string };

export type ShiftFacts = {
  merged: MergedPr[];
  decisionNeeded: number;
  recalls: number;
  queueLog: string;
  reworkReports: string[];
};

export function row(shift: Shift, foremanText: string, facts: ShiftFacts, stamp: Stamp): Row {
  const tickets = new Set(shift.agents.map((agent) => agent.ticket).filter((t) => /^\d+$/.test(t)));
  const reworked = new Set(shift.agents.filter((a) => isRework(a.step)).map((a) => a.ticket));
  const merged = facts.merged.filter((pr) => tickets.has(branchTicket(pr.headRefName) ?? ""));
  const queue = queueStats(facts.queueLog, shift.foreman.start, shift.foreman.end);
  const mergedTickets = new Set(merged.map((pr) => branchTicket(pr.headRefName)!));
  return {
    ...stamp,
    session: shift.session,
    date: localDate(new Date(shift.foreman.start)),
    start: new Date(shift.foreman.start).toISOString(),
    end: new Date(shift.foreman.end).toISOString(),
    mode: modeIn(invocation(foremanText) ?? ""),
    ticketsIn: tickets.size,
    merged: mergedTickets.size,
    wallMinutes: Math.round(totals(shift).wall),
    costState: shift.cost ?? null,
    transcripts: {
      leadRead: shift.foreman.read,
      agentsRead: shift.agents.reduce((sum, agent) => sum + agent.read, 0),
      leadPeak: shift.foreman.peak,
    },
    agents: shift.agents.map((agent) => ({
      ticket: agent.ticket,
      step: agent.step,
      minutes: Math.round(minutes(agent) * 10) / 10,
      turns: agent.turns,
      read: agent.read,
      written: agent.written,
      peak: agent.peak,
    })),
    mergedNoFixRound: [...mergedTickets].filter((t) => !reworked.has(t)).length,
    fixRounds: shift.agents.filter((a) => isRework(a.step)).length,
    reviewBugs: facts.reworkReports.reduce((sum, report) => sum + reviewBugs(report), 0),
    queueGreenFirstTry: queue.greenFirstTry,
    queueBatches: queue.batches,
    flakes: queue.flakes,
    drops: queue.drops,
    decisionNeeded: facts.decisionNeeded,
    handMerges: merged.filter((pr) => !queue.landed.has(pr.number)).length,
    escapes: facts.recalls,
  };
}

export const parseRows = (text: string): Row[] =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);

/** The timesheet with `added` in place of an earlier row for its session, oldest first. */
export const upsert = (rows: readonly Row[], added: Row): Row[] =>
  [...rows.filter((r) => r.session !== added.session), added].sort((a, b) =>
    a.start.localeCompare(b.start),
  );

const millions = (tokens: number) => `${(tokens / 1_000_000).toFixed(1)}M`;

export function table(rows: readonly Row[], rowsFile: string): string {
  const head = [
    "date",
    "who",
    "mode",
    "tickets in",
    "merged",
    "wall min",
    "read (cost-state)",
    "$",
    "foreman read",
    "agents read",
    "foreman peak",
    "merged, no rework",
    "rework",
    "review bugs",
    "queue green first try",
    "flakes",
    "drops",
    "decision needed",
    "hand merges",
    "recalls",
  ];
  const cells = (r: Row) => [
    r.date,
    [r.person, r.machine].filter(Boolean).join("@"),
    r.mode,
    r.ticketsIn,
    r.merged,
    r.wallMinutes,
    r.costState ? millions(r.costState.read) : "n/a",
    r.costState ? r.costState.usd.toFixed(2) : "n/a",
    millions(r.transcripts.leadRead),
    millions(r.transcripts.agentsRead),
    `${Math.round(r.transcripts.leadPeak / 1000)}k`,
    r.mergedNoFixRound,
    r.fixRounds,
    r.reviewBugs,
    `${r.queueGreenFirstTry}/${r.queueBatches}`,
    r.flakes,
    r.drops,
    r.decisionNeeded,
    r.handMerges,
    r.escapes,
  ];
  const line = (values: readonly unknown[]) => `| ${values.join(" | ")} |`;
  return [
    "# Timesheets",
    "",
    `One row per shift, newest first, from \`factory timesheet\`; \`factory timesheet --report\` sums the last 7 and 30 days. Read (cost-state) is Claude Code's exact session total, auto-mode classifier calls included; foreman and agents read come from the transcripts, which leave those calls out. The data is \`${rowsFile}\`.`,
    "",
    line(head),
    line(head.map(() => "---")),
    ...rows.toReversed().map((r) => line(cells(r))),
    "",
  ].join("\n");
}

const tablePath = (trail: PaperTrail) => join(dirname(trail.timesheet), "README.md");

export const readTimesheet = (trail: PaperTrail, sh: Exec) =>
  parseRows(readFile(trail.repo, trail.timesheet, sh)?.content ?? "");

/** Adds the shift's row, replacing an earlier one for its session, and redraws the table from it. */
export function saveRow(added: Row, trail: PaperTrail, sh: Exec) {
  const who = [added.person, added.machine].filter(Boolean).join("@");
  const message = `Timesheet: ${added.date} ${who} shift ${added.session.slice(0, 8)}`;
  const written = saveFile(
    trail.repo,
    trail.timesheet,
    (current) =>
      upsert(parseRows(current), added)
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    message,
    sh,
  );
  const rowsFile = trail.timesheet.split("/").at(-1)!;
  saveFile(trail.repo, tablePath(trail), () => table(parseRows(written), rowsFile), message, sh);
}

const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + "+00:00";

/** The searches for a shift: PRs merged, issues touched (for decision-needed labels added in the shift, whatever their labels now), and recalls filed since the previous shift ended up to this one's end. */
export function shiftSearches(repo: string, shift: Shift, previousEnd: string | undefined) {
  const from = iso(shift.foreman.start);
  const recallsFrom = previousEnd ? iso(Date.parse(previousEnd)) : from;
  return {
    merged: `repo:${repo} is:pr is:merged merged:>=${from}`,
    labeled: `repo:${repo} is:issue updated:>=${from}`,
    recalls: `repo:${repo} label:${RECALL} created:${recallsFrom}..${iso(shift.foreman.end)}`,
  };
}

/** What the shift's GitHub side and queue logs say. */
function shiftFacts(
  shift: Shift,
  previousEnd: string | undefined,
  transcripts: string,
  filing: Filing,
): ShiftFacts {
  const { sh } = filing;
  const searches = shiftSearches(filing.repo, shift, previousEnd);
  const inShift = (at: string) =>
    Date.parse(at) >= shift.foreman.start && Date.parse(at) <= shift.foreman.end;
  const merged = searchPullRequests<MergedPr>(
    searches.merged,
    "number headRefName mergedAt",
    sh,
  ).filter((pr) => inShift(pr.mergedAt));
  const touched = searchIssues<{
    timelineItems?: { nodes: { createdAt: string; label?: { name: string } }[] };
  }>(
    searches.labeled,
    "timelineItems(itemTypes: [LABELED_EVENT], last: 20) { nodes { ... on LabeledEvent { createdAt label { name } } } }",
    sh,
  );
  const recalls = graphql<{ search: { issueCount: number } }>(
    "query($q: String!) { search(type: ISSUE, query: $q, first: 1) { issueCount } }",
    { q: searches.recalls },
    sh,
  ).search.issueCount;
  const runs = join(projectHome(filing.project, filing.home), "runs");
  const logs = existsSync(runs)
    ? readdirSync(runs).map((name) => join(runs, name, "queue.log"))
    : [];
  const subagents = join(transcripts, shift.session, "subagents");
  return {
    merged,
    decisionNeeded: touched.filter(({ timelineItems }) =>
      timelineItems?.nodes.some((e) => e.label?.name === DECISION_NEEDED && inShift(e.createdAt)),
    ).length,
    recalls,
    queueLog: logs
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n"),
    reworkReports: shift.agents
      .filter((agent) => isRework(agent.step))
      .map((agent) => handBack(readFileSync(join(subagents, `agent-${agent.id}.jsonl`), "utf8"))),
  };
}

const DAY = 86_400_000;

const shifts = (n: number) => `${n} ${n === 1 ? "shift" : "shifts"}`;

/** The rows started in the last `days`, summed: speed and tokens beside rework, the queue, people's interventions and recalls. */
export function summary(rows: readonly Row[], days: number, now = Date.now()): string {
  const recent = rows.filter((r) => Date.parse(r.start) >= now - days * DAY);
  const sum = (pick: (r: Row) => number) => recent.reduce((s, r) => s + pick(r), 0);
  const merged = sum((r) => r.merged);
  const costed = recent.filter((r) => r.costState);
  const read = sum((r) => r.costState?.read ?? 0);
  const costedMerged = costed.reduce((s, r) => s + r.merged, 0);
  const perMerge = costedMerged
    ? `, ${(read / costedMerged / 1_000_000).toFixed(1)}M per merge`
    : "";
  const missing = recent.length - costed.length;
  const tokens =
    costed.length === 0
      ? "tokens\tn/a (no cost-state)"
      : `tokens\t${(read / 1_000_000).toFixed(1)}M read (cost-state)${perMerge}\t$${sum((r) => r.costState?.usd ?? 0).toFixed(2)}${missing ? `\t${shifts(missing)} n/a` : ""}`;
  return [
    `# last ${days} days: ${shifts(recent.length)}`,
    `speed\ttickets in ${sum((r) => r.ticketsIn)}\tmerged ${merged}\twall ${sum((r) => r.wallMinutes)} min`,
    tokens,
    `quality\tmerged with no rework ${sum((r) => r.mergedNoFixRound)}/${merged}\trework ${sum((r) => r.fixRounds)}\treview bugs ${sum((r) => r.reviewBugs)}`,
    `queue\tgreen first try ${sum((r) => r.queueGreenFirstTry)}/${sum((r) => r.queueBatches)}\tflakes ${sum((r) => r.flakes)}\tdrops ${sum((r) => r.drops)}`,
    `people\tdecision needed ${sum((r) => r.decisionNeeded)}\thand merges ${sum((r) => r.handMerges)}\trecalls ${sum((r) => r.escapes)}`,
  ].join("\n");
}

/** `factory timesheet [<session-id>] [--dry-run]` files the shift's row; `--report` sums the last 7 and 30 days. */
export function fileTimesheet(args: readonly string[], filing: Filing): number {
  const { trail, sh } = filing;
  if (args.length === 1 && args[0] === "--report") {
    const rows = readTimesheet(trail, sh);
    console.log(summary(rows, 7));
    console.log(summary(rows, 30));
    return 0;
  }
  const picked = sessionArgs(args, "--dry-run", "timesheet");
  if (typeof picked === "number") return picked;
  const { dir, session, flagged: dryRun } = picked;
  const shift = readShift(
    dir,
    session,
    Date.now(),
    readMarks(marksFile(filing.project, filing.home)),
  );
  const foremanText = readFileSync(join(dir, `${session}.jsonl`), "utf8");
  const previousEnd = readTimesheet(trail, sh)
    .filter((r) => r.session !== session && r.end < new Date(shift.foreman.start).toISOString())
    .at(-1)?.end;
  const added = row(shift, foremanText, shiftFacts(shift, previousEnd, dir, filing), filing.stamp);
  console.log(JSON.stringify(added));
  if (dryRun) return 0;
  saveRow(added, trail, sh);
  console.log(`timesheet: https://github.com/${trail.repo}/blob/HEAD/${tablePath(trail)}`);
  return 0;
}
