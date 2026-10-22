// Reads `claude -p --output-format stream-json` lines: a readable log line per event, and the session's summary.

type Block = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, string | undefined>;
};
type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};
export type StreamEvent = {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: Block[] };
  rate_limit_info?: { status?: string; resetsAt?: number };
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  modelUsage?: Record<string, ModelUsage>;
  usage?: Record<string, number | undefined>;
};

export type Summary = {
  session?: string;
  agents: number;
  tokens: number;
  turns: number;
  costUsd: number;
  result?: string;
  subtype?: string;
  isError?: boolean;
  /** Epoch seconds the usage limit lifts, when it stopped the session. */
  limitResetsAt?: number;
};

const AGENT_TOOLS = new Set(["Task", "Agent"]);
const HOUR = 3600;

const clip = (text: unknown, n: number) => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function toolLine(block: Block) {
  const input = block.input ?? {};
  const detail =
    input.command ??
    (input.subagent_type || input.description
      ? `${input.subagent_type ?? "agent"}: ${input.description ?? ""}`
      : undefined) ??
    input.skill ??
    input.file_path ??
    input.pattern ??
    input.url ??
    "";
  return `tool ${block.name} ${clip(detail, 160)}`.trimEnd();
}

/** One readable line per stream event worth reading, or none. */
export function readable(event: StreamEvent): string[] {
  const who = event.parent_tool_use_id ? "agent" : "foreman";
  if (event.type === "system" && event.subtype === "init")
    return [`init session ${event.session_id} model ${event.model}`];
  if (event.type === "assistant") {
    return (event.message?.content ?? []).flatMap((block) => {
      if (block.type === "text" && block.text?.trim()) return [`${who}: ${clip(block.text, 400)}`];
      if (block.type === "tool_use") return [`${who} ${toolLine(block)}`];
      return [];
    });
  }
  if (event.type === "rate_limit_event" && event.rate_limit_info?.status !== "allowed")
    return [`rate limit ${JSON.stringify(event.rate_limit_info)}`];
  if (event.type === "result")
    return [
      `result ${event.subtype}${event.is_error ? " (error)" : ""}: ${clip(event.result, 600)}`,
    ];
  return [];
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

function zoneOffsetMs(zone: string, at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - at.getTime();
}

// Wall-clock fields in a zone (the machine's when none) to epoch ms.
function wallToEpoch({ year, month, day, hour, minute }: Wall, zone: string | undefined) {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  return guess - zoneOffsetMs(zone, new Date(guess));
}

function wallNow(nowMs: number, zone: string | undefined) {
  const d = zone ? new Date(nowMs + zoneOffsetMs(zone, new Date(nowMs))) : new Date(nowMs);
  return zone
    ? { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }
    : { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Epoch seconds of "resets 3pm (Asia/Jerusalem)", "resets at 15:30", "resets Oct 13, 9am", "resets in 2h 5m"; undefined when it doesn't read as a time. */
export function parseReset(text: string, nowMs = Date.now()): number | undefined {
  const within = /resets? in\s+(?:(\d+)\s*h\w*)?\s*(?:(\d+)\s*m\w*)?/i.exec(text);
  if (within && (within[1] || within[2]))
    return Math.round(nowMs / 1000) + Number(within[1] ?? 0) * HOUR + Number(within[2] ?? 0) * 60;
  const phrase = /resets?\s+(?:at\s+|on\s+)?([^\n·•|]+)/i.exec(text)?.[1];
  if (!phrase) return undefined;
  if (/\d{4}-\d{2}-\d{2}/.test(phrase)) {
    const parsed = Date.parse(phrase.replace(/\s*\(.*$/, "").replace(/[^\w]+$/, ""));
    return Number.isNaN(parsed) ? undefined : Math.round(parsed / 1000);
  }
  const zone = /\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\)/.exec(phrase)?.[1];
  let rest = phrase.replace(/\(.*?\)/g, " ");
  const date = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?/i.exec(rest);
  const month = date ? MONTHS.indexOf(date[1]!.toLowerCase()) : -1;
  if (date && month >= 0)
    rest = rest.slice(0, date.index) + rest.slice(date.index + date[0].length);
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b|\b(\d{1,2}):(\d{2})\b/i.exec(rest);
  if (!time) return undefined;
  let hour = Number(time[1] ?? time[4]);
  const minute = Number(time[2] ?? time[5] ?? 0);
  if (time[3]) hour = (hour % 12) + (time[3].toLowerCase() === "pm" ? 12 : 0);
  if (hour > 23 || minute > 59) return undefined;
  const today = wallNow(nowMs, zone);
  const day = date && month >= 0 ? { ...today, month, day: Number(date[2]) } : today;
  let epoch = wallToEpoch({ ...day, hour, minute }, zone);
  if (epoch <= nowMs) epoch = wallToEpoch({ ...day, day: day.day + 1, hour, minute }, zone);
  return Math.round(epoch / 1000);
}

const LIMIT_TEXT = /usage limit reached|hit your (?:usage )?limit|limit reached[^\n]*resets/i;

/** Whether the text says a usage limit stopped the session, and when it lifts (epoch seconds; an hour out when it doesn't say). */
export function limitFromText(
  text: string | undefined,
  nowMs = Date.now(),
): { resetsAt: number } | undefined {
  if (!text || !LIMIT_TEXT.test(text)) return undefined;
  const epoch = /limit reached\|(\d{10,13})/i.exec(text)?.[1];
  if (epoch)
    return { resetsAt: epoch.length > 10 ? Math.round(Number(epoch) / 1000) : Number(epoch) };
  return { resetsAt: parseReset(text, nowMs) ?? Math.round(nowMs / 1000) + HOUR };
}

const TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

/** Folds stream events into the session's summary. */
export function summarize(events: readonly StreamEvent[], nowMs = Date.now()): Summary {
  const summary: Summary = { agents: 0, tokens: 0, turns: 0, costUsd: 0 };
  let rejectedAt: number | null | undefined;
  let lastText = "";
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") summary.session = event.session_id;
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use" && AGENT_TOOLS.has(block.name ?? "")) summary.agents += 1;
        if (block.type === "text" && !event.parent_tool_use_id) lastText = block.text ?? "";
      }
    }
    if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected")
      rejectedAt = event.rate_limit_info.resetsAt ?? rejectedAt ?? null;
    if (event.type === "result") {
      summary.result = event.result;
      summary.subtype = event.subtype;
      summary.isError = Boolean(event.is_error);
      summary.turns = event.num_turns ?? 0;
      summary.costUsd = event.total_cost_usd ?? 0;
      const models = Object.values(event.modelUsage ?? {});
      summary.tokens = models.length
        ? models.reduce(
            (sum, m) =>
              sum +
              (m.inputTokens ?? 0) +
              (m.outputTokens ?? 0) +
              (m.cacheReadInputTokens ?? 0) +
              (m.cacheCreationInputTokens ?? 0),
            0,
          )
        : TOKEN_KEYS.reduce((sum, key) => sum + (event.usage?.[key] ?? 0), 0);
    }
  }
  const said = limitFromText(summary.result ?? lastText, nowMs);
  // A rejected window can be followed by a fallback model, so it only counts when the session then stopped on an error.
  const stopped = summary.result === undefined || summary.isError;
  if (said) summary.limitResetsAt = rejectedAt ?? said.resetsAt;
  else if (rejectedAt !== undefined && stopped)
    summary.limitResetsAt = rejectedAt ?? Math.round(nowMs / 1000) + HOUR;
  if (summary.limitResetsAt !== undefined && summary.limitResetsAt > 1e12)
    summary.limitResetsAt = Math.round(summary.limitResetsAt / 1000);
  return summary;
}
