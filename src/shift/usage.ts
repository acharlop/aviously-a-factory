import type { Mark } from "../runtime/marks.ts";
import {
  compact,
  minutes,
  sessionArgs,
  type Shift,
  totals,
  type Usage,
  usageLine,
} from "../runtime/transcripts.ts";

/** Each agent's ticket, step, minutes, turns and tokens, then the shift's totals and its memo line. */
export function usageReport(shift: Shift): string[] {
  const row = (ticket: string, step: string, u: Usage, status: string) =>
    [
      ticket,
      step,
      minutes(u).toFixed(1),
      u.turns,
      compact(u.read),
      compact(u.written),
      compact(u.peak),
      status,
    ].join("\t");
  const total = totals(shift);
  return [
    `# session ${shift.session}${shift.start === undefined ? "" : ` · shift from ${new Date(shift.start).toISOString()}`}`,
    "# ticket\tstep\tminutes\tturns\tread\twritten≥\tpeak\tstatus",
    ...shift.agents.map((agent) =>
      row(agent.ticket, agent.step, agent, agent.running ? "running" : "done"),
    ),
    ...shift.earlier.map((agent) => row(agent.ticket, agent.step, agent, "before the shift")),
    row("foreman", "-", shift.foreman, "-"),
    `# total\t${shift.agents.length} agents + foreman\t${total.wall.toFixed(1)}\t${total.turns}\t${compact(total.read)}\t${compact(total.written)}\t-\t-`,
    `# memo: ${usageLine(shift)}`,
    ...(shift.cost
      ? [
          `# session cost-state: ${compact(shift.cost.read)} read, ${compact(shift.cost.written)} written, ${compact(shift.cost.thinking)} thinking, $${shift.cost.usd.toFixed(2)}`,
        ]
      : []),
  ];
}

/** A `[<session-id>] [--json]` command: reads the session's shift from its start and prints it as JSON or as its report. */
export function printShift<T>(
  args: readonly string[],
  command: string,
  marks: readonly Mark[],
  read: (dir: string, session: string, marks: readonly Mark[]) => T,
  json: (shift: T) => unknown,
  lines: (shift: T) => string[],
): number {
  const picked = sessionArgs(args, "--json", command);
  if (typeof picked === "number") return picked;
  const shift = read(picked.dir, picked.session, marks);
  if (picked.flagged) console.log(JSON.stringify(json(shift), null, 2));
  else for (const line of lines(shift)) console.log(line);
  return 0;
}
