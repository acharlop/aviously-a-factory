import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type MachineConfig, type Timeout, timeoutMinutes } from "../runtime/machine.ts";
import { type Mark, STEPS, type Step, stepMedians } from "../runtime/marks.ts";
import type { Agent } from "../runtime/transcripts.ts";

const STEP_TIMEOUTS: Record<Step, Timeout> = { queue: "TIMEOUT_QUEUE", run: "TIMEOUT_RUN" };

/** The timeout of each step a foreman names its agents by (`656 quality-control: spec`), and of each agent. */
const AGENT_TIMEOUTS: Record<string, Timeout> = {
  build: "TIMEOUT_CODER",
  temp: "TIMEOUT_CODER",
  "quality-control": "TIMEOUT_REVIEW",
  inspector: "TIMEOUT_REVIEW",
  rework: "TIMEOUT_FIX",
  "copy-desk": "TIMEOUT_STRINGS",
};

/** An agent's timeout from the first word of its step, else from its agent type, plugin prefix and axis aside. */
export function agentTimeout({ step, type }: Pick<Agent, "step" | "type">): Timeout | undefined {
  const word = /^[\w-]+/.exec(step.toLowerCase())?.[0] ?? "";
  const agent = type
    .split(":")
    .at(-1)!
    .replace(/^\w+-inspector$/, "inspector");
  return AGENT_TIMEOUTS[word] ?? AGENT_TIMEOUTS[agent];
}

/** Agents still running past their timeout at `now`, oldest first. */
function lateAgents(agents: readonly Agent[], config: MachineConfig, now: number) {
  return agents
    .filter(({ running }) => running)
    .sort((a, b) => a.start - b.start)
    .flatMap((agent) => {
      const setting = agentTimeout(agent);
      if (setting === undefined) return [];
      const limit = timeoutMinutes(config, setting);
      const minutes = (now - agent.start) / 60_000;
      return minutes > limit
        ? [
            {
              id: agent.id,
              line: `${agent.step}\t${agent.ticket}\t${Math.floor(minutes)} min\tpast ${setting} ${limit}`,
            },
          ]
        : [];
    });
}

export const overdueAgents = (agents: readonly Agent[], config: MachineConfig, now = Date.now()) =>
  lateAgents(agents, config, now).map(({ line }) => line);

/** Overdue agents not in `seen`, which it adds them to, so a watch reports each one once. */
export const newlyOverdue = (
  agents: readonly Agent[],
  config: MachineConfig,
  seen: Set<string>,
  now = Date.now(),
): string[] =>
  lateAgents(agents, config, now)
    .filter(({ id }) => !seen.has(id))
    .map(({ id, line }) => (seen.add(id), line));

/** Steps started in the latest shift and not ended, past their timeout at `now`, oldest first; a restart replaces the start before it. */
export function overdue(marks: readonly Mark[], config: MachineConfig, now = Date.now()) {
  const shiftStart = marks.findLast((m) => m.step === "run" && m.event === "start");
  const since = shiftStart ? Date.parse(shiftStart.at) : -Infinity;
  const open = new Map<string, { step: Step; key: string; start: number }>();
  for (const { step, event, at, key = "" } of marks) {
    if (!STEPS.includes(step)) continue;
    if (event === "start") open.set(`${step} ${key}`, { step, key, start: Date.parse(at) });
    else open.delete(`${step} ${key}`);
  }
  return [...open.values()]
    .filter(({ start }) => start >= since)
    .sort((a, b) => a.start - b.start)
    .flatMap(({ step, key, start }) => {
      const setting = STEP_TIMEOUTS[step];
      const limit = timeoutMinutes(config, setting);
      const minutes = (now - start) / 60_000;
      return minutes > limit
        ? [`${step}\t${key || "-"}\t${Math.floor(minutes)} min\tpast ${setting} ${limit}`]
        : [];
    });
}

/** What `factory timings` prints: anything overdue, then each step's median minutes. */
export function timingsReport(
  marks: readonly Mark[],
  agents: readonly Agent[],
  config: MachineConfig,
  now = Date.now(),
): string[] {
  const late = [...overdue(marks, config, now), ...overdueAgents(agents, config, now)];
  return [
    ...(late.length > 0 ? ["# OVERDUE: step\tticket\trunning\ttimeout", ...late] : []),
    ...stepMedians(marks),
  ];
}

/** Appends a start or end mark to the project's marks file. */
export function mark(
  file: string,
  step: Step,
  event: Mark["event"],
  key?: string,
  at = new Date(),
) {
  const added: Mark = { step, event, at: at.toISOString(), ...(key && { key }) };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(added)}\n`);
}
