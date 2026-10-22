import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Mark } from "../runtime/marks.ts";
import { latestShiftStart, records, subagentTranscripts, usage } from "../runtime/transcripts.ts";

export type Call = {
  agent: string;
  tool: string;
  start: number;
  ms: number;
  bytes: number;
  target: string;
};

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: unknown;
};

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? content : []);

const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : blocks(content)
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("\n");

const TARGET_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"];

/** What a call ran or touched: a Bash command, a file path, a search, an agent's description. */
function target(input: Record<string, unknown> = {}): string {
  const key = TARGET_KEYS.find((k) => typeof input[k] === "string");
  return key ? (input[key] as string) : "";
}

/** One transcript's tool calls, each timed from its tool_use to its tool_result; a call with no result yet is left out. */
export function calls(text: string, agent: string): Call[] {
  const all = records(text);
  const at = (timestamp?: string) => Date.parse(timestamp ?? "");
  const uses = new Map(
    all
      .filter((r) => r.type === "assistant")
      .flatMap((r) =>
        blocks(r.message?.content)
          .filter((b) => b.type === "tool_use" && b.id)
          .map((b) => [
            b.id!,
            { agent, tool: b.name ?? "-", start: at(r.timestamp), target: target(b.input) },
          ]),
      ),
  );
  return all
    .filter((r) => r.type === "user")
    .flatMap((r) =>
      blocks(r.message?.content).flatMap((b) => {
        const started = b.type === "tool_result" ? uses.get(b.tool_use_id ?? "") : undefined;
        if (!started) return [];
        const ms = Math.max(0, at(r.timestamp) - started.start);
        return [{ ...started, ms, bytes: Buffer.byteLength(resultText(b.content)) }];
      }),
    );
}

export type CallShift = { session: string; start?: number; calls: Call[] };

/** The foreman's and every agent's calls from the shift's start, as `factory usage` counts it. */
export function readCalls(dir: string, session: string, marks: readonly Mark[] = []): CallShift {
  const foremanText = readFileSync(join(dir, `${session}.jsonl`), "utf8");
  const start = latestShiftStart(marks, usage(foremanText).end);
  const all = [
    ...calls(foremanText, "foreman"),
    ...subagentTranscripts(dir, session).flatMap(({ id, meta, transcript }) =>
      calls(transcript, meta.description?.trim() || id),
    ),
  ].filter((call) => !(call.start < (start ?? -Infinity)));
  return { session, ...(start !== undefined && { start }), calls: all };
}

type Heavy = readonly (readonly [string, RegExp])[];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The heavy commands a performance review tracks, in the order the table prints them: the project's own, then every project's. */
export const heavy = (project: readonly string[]): Heavy => [
  ...project.map(
    (command) => [command, new RegExp(`(?<![\\w-])${escape(command)}(?![\\w-])`)] as const,
  ),
  ["git push", /\bgit\s+push\b/],
  [
    "package tests",
    /\b(?:pnpm|turbo)\b.*(?<![\w./-])test(?![\w:.-])|\bnode\b.*\s--test\b|\bvitest\b/,
  ],
];

const segments = (command: string) =>
  command
    .split(/&&|\|\||;|\n/)
    .map((part) => part.trim())
    .filter(Boolean);

/** The groups a Bash command counts under: each heavy command it chains, else the rest. */
export function groups(command: string, commands: Heavy): string[] {
  const parts = segments(command);
  const found = commands
    .filter(([, pattern]) => parts.some((part) => pattern.test(part)))
    .map(([name]) => name);
  return found.length > 0 ? found : ["the rest"];
}

export type Group = { name: string; count: number; ms: number; bytes: number };

/** Bash calls per group, every heavy one in order and then the rest, empty ones too so shifts compare row by row. */
export function bashGroups(all: readonly Call[], commands: Heavy): Group[] {
  const found = new Map<string, Group>(
    [...commands.map(([name]) => name), "the rest"].map((name) => [
      name,
      { name, count: 0, ms: 0, bytes: 0 },
    ]),
  );
  for (const call of all.filter((c) => c.tool === "Bash"))
    for (const name of groups(call.target, commands)) {
      const group = found.get(name)!;
      group.count += 1;
      group.ms += call.ms;
      group.bytes += call.bytes;
    }
  return [...found.values()];
}

const min = (ms: number) => (ms / 60_000).toFixed(1);
const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
};

export function callsReport(shift: CallShift, commands: Heavy): string[] {
  const row = (c: Call) =>
    [c.agent, c.tool, min(c.ms), kb(c.bytes), oneLine(c.target) || "-"].join("\t");
  const top = (by: (c: Call) => number) =>
    [...shift.calls].sort((a, b) => by(b) - by(a)).slice(0, 10);
  return [
    `# session ${shift.session}${shift.start === undefined ? "" : ` · shift from ${new Date(shift.start).toISOString()}`} · ${shift.calls.length} calls`,
    "# bash\tcalls\tminutes\toutput KB",
    ...bashGroups(shift.calls, commands).map((g) =>
      [g.name, g.count, min(g.ms), kb(g.bytes)].join("\t"),
    ),
    "# slowest: agent\ttool\tminutes\toutput KB\tcommand or path",
    ...top((c) => c.ms).map(row),
    "# largest output: agent\ttool\tminutes\toutput KB\tcommand or path",
    ...top((c) => c.bytes).map(row),
  ];
}
