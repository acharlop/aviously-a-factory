import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { PaperTrail } from "../../../config/schema.ts";
import type { Exec } from "../../../runtime/exec.ts";
import { gh, ghJson } from "../../../runtime/github.ts";
import { machineConfig, shiftCount, timeoutMinutes } from "../../../runtime/machine.ts";
import { type Mark, marksFile, readMarks, stepMedians } from "../../../runtime/marks.ts";
import {
  currentSession,
  projectDir,
  readShift,
  type Shift,
  usageLine,
} from "../../../runtime/transcripts.ts";
import { type Filing, localDate, localTime, type Mode, MODES, type Stamp } from "./record.ts";

/** What the foreman writes; the memo owns the layout, the title and the shift marker. */
export type Input = {
  mode: Mode;
  summary: string;
  day: string;
  intake: string;
  mix: string;
  merged?: string[];
  reds?: string[];
  stalls?: string[];
  timeouts?: string[];
  queued?: string[];
  calls?: string[];
  filed?: string[];
  proposed?: string[];
  notes?: string[];
};

/** What the memo reads itself: the clock, the shift's start and number, the transcripts, the queue log and the step medians. */
export type Context = {
  now: Date;
  started: Date;
  repo: string;
  shift: number;
  stamp: Stamp;
  usage: Shift | undefined;
  runDir: string | undefined;
  queueLog: string;
  timings: string[];
};

export type Memo = {
  number: number;
  title: string;
  body: string;
  url: string;
};

/** The line a runner looks for to tell that a shift filed its memo. */
export const marker = (shift: number) => `<!-- run ${shift} -->`;

const who = ({ person, machine }: Stamp) => `${person}@${machine.toLowerCase()}`;

export function parseInput(text: string): Input {
  const input = JSON.parse(text) as Partial<Input>;
  if (!MODES.includes(input.mode as Mode))
    throw new Error(`memo input: mode must be one of ${MODES.join(", ")}`);
  for (const key of ["summary", "day", "intake", "mix"] as const)
    if (typeof input[key] !== "string" || !input[key].trim())
      throw new Error(`memo input: ${key} is required`);
  for (const key of ["summary", "day", "mix"] as const)
    if (input[key]!.includes("\n")) throw new Error(`memo input: ${key} must be one line`);
  return input as Input;
}

/** The queue's Landed/Dropped lines written since the shift started, each PR number linked to its PR in `repo`. */
export function queueOutcomes(log: string, since: number, repo: string): string[] {
  return log.split("\n").flatMap((line) => {
    const found = /^(\S+) merge-queue: (Landed: .*)$/.exec(line);
    return found && Date.parse(found[1]!) >= since
      ? [found[2]!.replace(/#(\d+)\b/g, `[#$1 🔀](https://github.com/${repo}/pull/$1)`)]
      : [];
  });
}

/** When the shift began: its open start mark, else now; a mark older than the shift's timeout was left by a crashed shift. */
export function shiftStart(marks: readonly Mark[], now: Date, limitMinutes: number): Date {
  const last = marks.findLast((mark) => mark.step === "run");
  if (last?.event !== "start") return now;
  const at = new Date(last.at);
  return now.getTime() - at.getTime() > limitMinutes * 60_000 ? now : at;
}

const list = (items: readonly string[] | undefined) => (items?.length ? items.join(", ") : "none");
const bullets = (items: readonly string[] | undefined, box = "") =>
  items?.length
    ? items.map((item) => `- ${box}${item.trim().replace(/\n/g, "\n  ")}`).join("\n")
    : "None.";

export function section(input: Input, ctx: Context): string {
  const queue = queueOutcomes(ctx.queueLog, ctx.usage?.foreman.start ?? -Infinity, ctx.repo);
  const { step, factory, steps } = ctx.stamp;
  return [
    `## ${localTime(ctx.now)} · ${input.mode} · ${input.summary.trim()}`,
    marker(ctx.shift),
    "",
    `- **Merged:** ${list(input.merged)}`,
    `- **Reds:** ${list(input.reds)}`,
    `- **Stalls:** ${list(input.stalls)}`,
    `- **Timeouts:** ${list(input.timeouts)}`,
    `- **Queued:** ${list(input.queued)}`,
    `- **Queue:** ${queue.length ? queue.join(" ") : "no queue run"}`,
    `- **Intake:** ${input.intake.trim()} Shift ${ctx.shift}.`,
    `- **Mix:** ${input.mix.trim()}`,
    `- **Usage:** ${ctx.usage ? usageLine(ctx.usage) : "no factory transcript found"}`,
    `- **Logs:** ${ctx.runDir ? `\`${ctx.runDir}\`` : "none"}`,
    "",
    "### Calls made",
    "",
    bullets(input.calls),
    "",
    "### Filed",
    "",
    bullets(input.filed),
    "",
    "### Proposed follow-ups",
    "",
    bullets(input.proposed, "[ ] "),
    "",
    "<details><summary>For AI</summary>",
    "",
    // Each agent's usage row goes to the timesheet: a day of them ran the issue past GitHub's 65k body cap.
    ctx.usage
      ? `**Agent usage**: in the timesheet's row for session \`${ctx.usage.session}\``
      : "**Agent usage**: no factory transcript found",
    "",
    `**Filed by**: ${step}, factory ${factory}, steps ${steps.join(" ") || "none"}`,
    "",
    "**Step timings**",
    "",
    "```",
    ...ctx.timings,
    "```",
    ...(input.notes?.length ? ["", "**Notes**", "", bullets(input.notes)] : []),
    "",
    "</details>",
  ].join("\n");
}

/** The body with this shift's section replaced, or added at the end when the shift has none yet. */
export function withSection(body: string, shift: number, text: string): string {
  const lines = body.split("\n");
  const at = lines.indexOf(marker(shift));
  if (at < 1 || !lines[at - 1]!.startsWith("## "))
    return body.trim() ? `${body.trimEnd()}\n\n${text}` : text;
  const next = lines.findIndex((line, i) => i > at && line.startsWith("## "));
  const after = next < 0 ? [] : ["", ...lines.slice(next)];
  return [...lines.slice(0, at - 1), ...text.split("\n"), ...after].join("\n");
}

export type Box = { ticked: boolean; text: string; settled: boolean };

/** A box is settled once its line ends with `→` and the filed ticket or the answer. */
const SETTLED = /→\s*(?:\[[^\]]*\]\(https?:\/\/[^)\s]+\)|<?https?:\/\/\S+?>?)\s*$/;

/** The checkboxes under each Proposed follow-ups heading. */
export function followUps(body: string): Box[] {
  const boxes: Box[] = [];
  let inside = false;
  for (const line of body.split("\n")) {
    if (/^#{1,6} /.test(line)) inside = /proposed follow-ups/i.test(line);
    const box = inside && /^\s*[-*] \[([ xX])\]\s*(.*)$/.exec(line);
    if (box) boxes.push({ ticked: box[1] !== " ", text: box[2]!, settled: SETTLED.test(box[2]!) });
  }
  return boxes;
}

const titleDate = (title: string) => /^Factory (?:run )?(\d{4}-\d{2}-\d{2})\b/.exec(title)?.[1];

/** A past day's memo whose every follow-up is filed or answered. */
export const closable = (memo: Memo, today: string) => {
  const day = titleDate(memo.title);
  return day !== undefined && day < today && followUps(memo.body).every((box) => box.settled);
};

export type Published = { said: string[]; status: number };

const listMemos = (trail: PaperTrail, sh: Exec, state: string, ...search: string[]) =>
  ghJson<(Memo & { state: string })[]>(
    [
      "issue",
      "list",
      "-R",
      trail.repo,
      "--label",
      trail.memoLabel,
      "--state",
      state,
      ...search,
      "--limit",
      "100",
      "--json",
      "number,title,body,url,state",
    ],
    sh,
  );

const unfiledFollowUps = (open: readonly Memo[]) =>
  open.flatMap((memo) =>
    followUps(memo.body)
      .filter((box) => box.ticked && !box.settled)
      .map((box) => `#${memo.number}: ${box.text}`),
  );

type GhRun = (args: string[], stdin?: string) => string;

/** Edits this machine's memo for the day, reopening it when it was closed by hand, or opens it. */
function writeMemo(
  trail: PaperTrail,
  mine: (Memo & { state: string }) | undefined,
  title: string,
  body: string,
  run: GhRun,
) {
  const { repo, memoLabel } = trail;
  if (!mine)
    return run(
      ["issue", "create", "-R", repo, "--label", memoLabel, "--title", title, "--body-file", "-"],
      body,
    );
  if (mine.state.toLowerCase() !== "open")
    run(["issue", "reopen", String(mine.number), "-R", repo]);
  run(
    ["issue", "edit", String(mine.number), "-R", repo, "--title", title, "--body-file", "-"],
    body,
  );
  return mine.url;
}

export function publish(
  input: Input,
  ctx: Context,
  trail: PaperTrail,
  sh: Exec,
  dryRun = false,
): Published {
  const open = listMemos(trail, sh, "open");
  const unfiled = unfiledFollowUps(open);
  if (unfiled.length > 0)
    return {
      status: 1,
      said: [
        "ticked follow-ups not filed yet; file each, end its line with `→ <ticket link>`, then rerun:",
        ...unfiled,
      ],
    };

  const today = localDate(ctx.started);
  const prefix = `Factory ${today} · ${who(ctx.stamp)} · `;
  const mine = listMemos(trail, sh, "all", "--search", `"Factory ${today}" in:title`).find((memo) =>
    memo.title.toLowerCase().startsWith(prefix.toLowerCase()),
  );
  const title = `${prefix}${input.day.trim()}`;
  const body = withSection(mine?.body ?? "", ctx.shift, section(input, ctx));
  const run: GhRun = (args, stdin) => (dryRun ? "" : gh(args, sh, stdin));
  const url = writeMemo(trail, mine, title, body, run);
  const said = dryRun ? [`# ${title}`, body] : [];
  const [doing, did] = mine ? ["write", "wrote"] : ["open", "opened"];
  said.push(
    `${dryRun ? `would ${doing}` : did} shift ${ctx.shift} on the day's memo ${url}`.trimEnd(),
  );
  for (const memo of open) {
    if (memo.number === mine?.number || !closable(memo, today)) continue;
    run([
      "issue",
      "close",
      String(memo.number),
      "-R",
      trail.repo,
      "--comment",
      "Day over; every follow-up is filed or answered.",
    ]);
    said.push(
      `${dryRun ? "would close" : "closed"} ${memo.url}: day over, every follow-up settled`,
    );
  }
  return { status: 0, said };
}

function context(filing: Filing, runDir: string | undefined): Context {
  const { project, home } = filing;
  const dir = projectDir();
  const session = currentSession(dir);
  const queueFile = runDir ? join(runDir, "queue.log") : "";
  const marks = readMarks(marksFile(project, home));
  const now = new Date();
  return {
    now,
    started: shiftStart(marks, now, timeoutMinutes(machineConfig(project, home), "TIMEOUT_RUN")),
    repo: filing.repo,
    shift: shiftCount(project, home),
    stamp: filing.stamp,
    usage: session ? readShift(dir, session, now.getTime(), marks) : undefined,
    runDir,
    queueLog: queueFile && existsSync(queueFile) ? readFileSync(queueFile, "utf8") : "",
    timings: stepMedians(marks),
  };
}

/** `factory memo <input.json> [--dry-run] [--run-dir <path>]` files the shift's section on this machine's memo for the day. */
export function fileMemo(args: readonly string[], filing: Filing): number {
  const dryRun = args.includes("--dry-run");
  const at = args.indexOf("--run-dir");
  const runDir = at < 0 ? undefined : args[at + 1];
  const rest = args.filter(
    (arg, i) => arg !== "--dry-run" && (at < 0 || (i !== at && i !== at + 1)),
  );
  if (rest.length !== 1 || rest[0]!.startsWith("-") || (at >= 0 && !runDir)) {
    console.log("usage: factory memo <input.json> [--dry-run] [--run-dir <path>]");
    return 2;
  }
  const { said, status } = publish(
    parseInput(readFileSync(rest[0]!, "utf8")),
    context(filing, runDir && resolve(runDir)),
    filing.trail,
    filing.sh,
    dryRun,
  );
  for (const line of said) console.log(dryRun ? line : `memo: ${line}`);
  return status;
}
