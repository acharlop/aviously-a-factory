import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent, Shift, Usage } from "../runtime/transcripts.ts";
import { usageReport } from "./usage.ts";

const at = (minute: number) => Date.UTC(2026, 9, 13, 21, minute);
const usage = (start: number, end: number, read: number, written: number, peak = read): Usage => ({
  turns: 2,
  read,
  written,
  peak,
  start: at(start),
  end: at(end),
});
const agent = (step: string, running: boolean, u: Usage): Agent => ({
  id: step,
  ticket: "7",
  step,
  type: "aviously-a-factory:temp",
  running,
  ...u,
});

test("the report has a row per agent, the earlier ones apart, the foreman, the totals and the memo line", () => {
  const shift: Shift = {
    session: "s-1",
    start: at(0),
    foreman: usage(0, 30, 73_000, 130, 42_000),
    agents: [
      agent("build", false, usage(2, 24, 45_000, 30, 25_000)),
      agent("quality-control: spec", true, usage(26, 40, 10_000, 5)),
    ],
    earlier: [agent("reality-check", false, usage(-10, -5, 4_000, 2))],
    cost: { read: 3_000, written: 400, thinking: 90, usd: 1.5 },
  };
  assert.deepEqual(usageReport(shift), [
    `# session s-1 · shift from ${new Date(at(0)).toISOString()}`,
    "# ticket\tstep\tminutes\tturns\tread\twritten≥\tpeak\tstatus",
    "7\tbuild\t22.0\t2\t45k\t30\t25k\tdone",
    "7\tquality-control: spec\t14.0\t2\t10k\t5\t10k\trunning",
    "7\treality-check\t5.0\t2\t4k\t2\t4k\tbefore the shift",
    "foreman\t-\t30.0\t2\t73k\t130\t42k\t-",
    "# total\t2 agents + foreman\t30.0\t6\t128k\t165\t-\t-",
    "# memo: wall 30 min · 128k tokens read, ≥165 written · 2 agents · foreman 73k read, 73k per ticket (1), peak context 42k",
    "# session cost-state: 3k read, 400 written, 90 thinking, $1.50",
  ]);
});
