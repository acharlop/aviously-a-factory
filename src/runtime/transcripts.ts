import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Mark } from "./marks.ts";

/** Tokens, turns and the time span of one Claude Code transcript. */
export type Usage = {
  turns: number;
  read: number;
  written: number;
  peak: number;
  start: number;
  end: number;
};

export type Agent = Usage & {
  id: string;
  ticket: string;
  step: string;
  type: string;
  running: boolean;
};

export type Cost = { read: number; written: number; thinking: number; usd: number };

/** `agents` and `foreman` count from the shift's start; `earlier` are the session's agents that started before it. */
export type Shift = {
  session: string;
  foreman: Usage;
  agents: Agent[];
  earlier: Agent[];
  start?: number;
  cost?: Cost;
};

type Entry = {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  totalCostUSD?: number;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      thinkingTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
  message?: {
    id?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
  };
};

export const records = (text: string): Entry[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as Entry] : [];
    } catch {
      return [];
    }
  });

/** Tokens and turns of one transcript; a reply split over several records (one per content block) counts once, with its largest output count, which is still a lower bound. */
export function usage(text: string, since = -Infinity): Usage {
  const replies = new Map<string, { read: number; written: number }>();
  const total: Usage = { turns: 0, read: 0, written: 0, peak: 0, start: Infinity, end: -Infinity };
  const counted = records(text).filter(({ timestamp }) => !(Date.parse(timestamp ?? "") < since));
  for (const { type, timestamp, message } of counted) {
    if (timestamp) {
      const at = Date.parse(timestamp);
      total.start = Math.min(total.start, at);
      total.end = Math.max(total.end, at);
    }
    const counts = message?.usage;
    if (type !== "assistant" || !counts || !message.id) continue;
    const read =
      (counts.input_tokens ?? 0) +
      (counts.cache_read_input_tokens ?? 0) +
      (counts.cache_creation_input_tokens ?? 0);
    const seen = replies.get(message.id);
    replies.set(message.id, {
      read: seen?.read ?? read,
      written: Math.max(seen?.written ?? 0, counts.output_tokens ?? 0),
    });
  }
  for (const { read, written } of replies.values()) {
    total.turns += 1;
    total.read += read;
    total.written += written;
    total.peak = Math.max(total.peak, read);
  }
  return total;
}

/** The session's exact totals from Claude Code's last `cost-state` record, when it wrote one. */
export function cost(text: string): Cost | undefined {
  const last = records(text).findLast((r) => r.type === "cost-state");
  if (!last) return undefined;
  const total: Cost = { read: 0, written: 0, thinking: 0, usd: last.totalCostUSD ?? 0 };
  for (const model of Object.values(last.modelUsage ?? {})) {
    total.read +=
      (model.inputTokens ?? 0) +
      (model.cacheReadInputTokens ?? 0) +
      (model.cacheCreationInputTokens ?? 0);
    total.written += model.outputTokens ?? 0;
    total.thinking += model.thinkingTokens ?? 0;
  }
  return total;
}

/** `656 review: spec` is ticket 656, step `review: spec`; a description in another shape keeps its first number as the ticket and itself as the step. */
export function label(description: string): { ticket: string; step: string } {
  const named = /^(\d+) (.+)$/.exec(description.trim());
  if (named) return { ticket: named[1]!, step: named[2]! };
  return { ticket: /\b(\d+)\b/.exec(description)?.[1] ?? "-", step: description.trim() || "-" };
}

/** When the foreman last heard each background agent stop, by agent id. */
export function stops(foremanText: string): Map<string, number> {
  const stopped = new Map<string, number>();
  for (const line of foremanText.split("\n")) {
    if (!line.includes("<task-notification>")) continue;
    const at = Date.parse((records(line)[0]?.timestamp ?? "") || "");
    for (const [, id] of line.matchAll(
      /<task-notification>(?:\\n|\s)*<task-id>([\w-]+)<\/task-id>/g,
    ))
      if (Number.isFinite(at)) stopped.set(id!, Math.max(stopped.get(id!) ?? -Infinity, at));
  }
  return stopped;
}

/** The latest shift start mark at or before the session's end, so a session that also did other work counts only the shift. */
export function latestShiftStart(marks: readonly Mark[], sessionEnd: number): number | undefined {
  const start = marks.findLast(
    (m) => m.step === "run" && m.event === "start" && Date.parse(m.at) <= sessionEnd,
  );
  return start ? Date.parse(start.at) : undefined;
}

/** Each subagent's id, its meta file's type and description, and its transcript. */
export function subagentTranscripts(dir: string, session: string) {
  const subagents = join(dir, session, "subagents");
  const files = existsSync(subagents)
    ? readdirSync(subagents).filter((name) => /^agent-.+\.jsonl$/.test(name))
    : [];
  return files.map((name) => {
    const id = name.slice("agent-".length, -".jsonl".length);
    const metaFile = join(subagents, `agent-${id}.meta.json`);
    const meta = existsSync(metaFile)
      ? (JSON.parse(readFileSync(metaFile, "utf8")) as { agentType?: string; description?: string })
      : {};
    return { id, meta, transcript: readFileSync(join(subagents, name), "utf8") };
  });
}

export function readShift(
  dir: string,
  session: string,
  now = Date.now(),
  marks: readonly Mark[] = [],
): Shift {
  const foremanText = readFileSync(join(dir, `${session}.jsonl`), "utf8");
  const start = latestShiftStart(marks, usage(foremanText).end);
  const stopped = stops(foremanText);
  const agents = subagentTranscripts(dir, session).map(({ id, meta, transcript }): Agent => {
    const counted = usage(transcript);
    const running =
      !((stopped.get(id) ?? -Infinity) >= counted.end) && !endsWithHandback(transcript);
    return {
      id,
      ...label(meta.description ?? ""),
      type: meta.agentType ?? "-",
      ...counted,
      ...(running && { end: now }),
      running,
    };
  });
  agents.sort(
    (a, b) => a.ticket.localeCompare(b.ticket, "en", { numeric: true }) || a.start - b.start,
  );
  const since = start ?? -Infinity;
  const exact = cost(foremanText);
  return {
    session,
    foreman: usage(foremanText, since),
    agents: agents.filter((agent) => agent.start >= since),
    earlier: agents.filter((agent) => agent.start < since),
    ...(start !== undefined && { start }),
    ...(exact && { cost: exact }),
  };
}

export const minutes = ({ start, end }: Usage) => (end > start ? (end - start) / 60_000 : 0);

export function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function totals({ foreman, agents }: Shift) {
  const all = [foreman, ...agents];
  const sum = (key: "turns" | "read" | "written") => all.reduce((s, row) => s + row[key], 0);
  return {
    wall: minutes(foreman),
    turns: sum("turns"),
    read: sum("read"),
    written: sum("written"),
  };
}

/** The shift's usage in one line, as its memo shows it. */
export function usageLine(shift: Shift): string {
  const total = totals(shift);
  const tickets = new Set(shift.agents.map((agent) => agent.ticket).filter((t) => t !== "-")).size;
  const perTicket = tickets
    ? `, ${compact(Math.round(shift.foreman.read / tickets))} per ticket (${tickets})`
    : "";
  return `wall ${Math.round(total.wall)} min · ${compact(total.read)} tokens read, ≥${compact(total.written)} written · ${shift.agents.length} agents · foreman ${compact(shift.foreman.read)} read${perTicket}, peak context ${compact(shift.foreman.peak)}`;
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: { text?: unknown }) => (typeof block?.text === "string" ? block.text : ""))
          .join("\n")
      : "";

const isLocal = (said: string) => said.startsWith("<local-command-");

/** `/factory`, a project's `/<name>-factory` or a plugin's `/<plugin>:factory`, as a slash command or typed. */
const factoryCommand =
  /<command-name>\/(?:[\w-]+:)?(?:[\w-]+-)?factory<\/command-name>|^\/(?:[\w-]+:)?(?:[\w-]+-)?factory\b/;

const runnerPrompt = /^Invoke the (?:[\w-]+-)?factory skill\b/;

const invokes = (said: string) =>
  !isLocal(said) && (factoryCommand.test(said) || runnerPrompt.test(said));

/** What the user records say, meta and local-command records (a `/model` first) left out. */
const userSaid = (all: readonly Entry[]) =>
  all
    .filter((r) => r.type === "user" && !r.isMeta)
    .map((r) => text(r.message?.content).trim())
    .filter((said) => !isLocal(said));

/** The first user record that invokes the factory, the slash command, typed or not, or the runner's prompt, even after a stray first prompt. */
export const invocation = (transcript: string): string | undefined =>
  userSaid(records(transcript)).find(invokes);

/** Whether the session is a shift: the factory invoked before its first reply, so a later `/factory` is a mention mid-session. */
export function invokesFactory(transcript: string): boolean {
  const all = records(transcript);
  const replied = all.findIndex((r) => r.type === "assistant");
  return userSaid(all.slice(0, replied < 0 ? all.length : replied)).some(invokes);
}

const replies = (transcript: string) => records(transcript).filter((r) => r.type === "assistant");

const handbackIn = ({ message }: Entry): string | undefined => {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const sent = blocks.find(
    (b: { type?: string; name?: string }) =>
      b?.type === "tool_use" && b.name === "SubagentHandback",
  ) as { input?: { message?: unknown } } | undefined;
  return typeof sent?.input?.message === "string" ? sent.input.message : undefined;
};

/** The agent's last SubagentHandback message, if it sent one. */
export function subagentHandback(transcript: string): string | undefined {
  for (const reply of replies(transcript).toReversed()) {
    const sent = handbackIn(reply);
    if (sent !== undefined) return sent;
  }
  return undefined;
}

/** A foreground agent's only sign it finished: its last reply is a SubagentHandback, so one resumed with SendMessage after it handed back is still working. */
export function endsWithHandback(transcript: string): boolean {
  const last = replies(transcript).at(-1);
  return last !== undefined && handbackIn(last) !== undefined;
}

/** An agent's report: its SubagentHandback message, else its last reply's text. */
export function handBack(transcript: string): string {
  return (
    subagentHandback(transcript) ??
    replies(transcript)
      .map((r) => text(r.message?.content))
      .findLast((said) => said.trim()) ??
    ""
  );
}

/** The newest transcript in `dir` that is a shift. */
export function latestSession(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .find(({ name }) => invokesFactory(readFileSync(join(dir, name), "utf8")))
    ?.name.slice(0, -".jsonl".length);
}

/** The shift to read: this shell's own session when Claude Code names one (`CLAUDE_CODE_SESSION_ID`) and its transcript is here, else the newest shift. */
export function currentSession(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const own = env.CLAUDE_CODE_SESSION_ID;
  if (own && existsSync(join(dir, `${own}.jsonl`))) return own;
  return latestSession(dir);
}

/** Claude Code's transcript folder for the main checkout, so a shift from a worktree still finds the foreman's. */
export function projectDir(cwd = process.cwd()): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const root = basename(common) === ".git" ? dirname(common) : common;
  return join(homedir(), ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The session a full id or a unique prefix of one names. */
export function findSession(dir: string, id: string): string | { error: string } {
  if (existsSync(join(dir, `${id}.jsonl`))) return id;
  const matches = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(id) && name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -".jsonl".length))
    : [];
  if (matches.length === 1) return matches[0]!;
  return {
    error: matches.length
      ? `${id} names ${matches.length} transcripts in ${dir}: ${matches.join(", ")}`
      : `no factory transcript ${id} in ${dir}`,
  };
}

/** A command's `[<session-id>] [<flag>]` arguments: the session named, else this shell's or the newest shift, and its transcript folder; on bad arguments or a missing transcript it prints why and gives the exit code. */
export function sessionArgs(
  args: readonly string[],
  flag: string,
  command: string,
  dir = projectDir(),
): { dir: string; session: string; flagged: boolean } | number {
  const flagged = args.includes(flag);
  const rest = args.filter((arg) => arg !== flag);
  if (rest.length > 1 || rest.some((arg) => arg.startsWith("-"))) {
    console.log(`usage: factory ${command} [<session-id>] [${flag}]`);
    return 2;
  }
  const session = rest[0] === undefined ? currentSession(dir) : findSession(dir, rest[0]);
  if (typeof session !== "string") {
    console.log(session?.error ?? `no factory transcript in ${dir}`);
    return 1;
  }
  return { dir, session, flagged };
}
