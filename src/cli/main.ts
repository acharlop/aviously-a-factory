#!/usr/bin/env node
import { ConfigError, loadProject } from "../config/load.ts";
import { jsonSchema } from "../config/schema.ts";
import { FACTORY_VERSION } from "../version.ts";
import { doctor } from "./doctor.ts";
import { memo, timesheet } from "./file.ts";
import { labels } from "./labels.ts";
import { migrate } from "./migrate.ts";
import { mobile } from "./mobile.ts";
import { untriaged } from "./untriaged.ts";
import { claim, free, inFlight, inspectors, park, push } from "./foreman.ts";
import { reviewDone, reviewDue, suggestionBox } from "./file.ts";
import { calls, clean, commentEdit, epicClose, stopE2e, timings, usage } from "./shift.ts";

const COMMANDS: Record<string, { summary: string; run: (args: string[]) => Promise<number> }> = {
  doctor: { summary: "Check the config, the plugin and this machine", run: doctor },
  labels: {
    summary: "Show how the repo's labels differ from the factory set; --apply fixes them",
    run: (args) => labels(args),
  },
  resolve: {
    summary: "Validate factory.config.ts and write .factory/resolved.json",
    run: async () => {
      console.log(JSON.stringify(await loadProject(), null, 2));
      return 0;
    },
  },
  schema: {
    summary: "Print the JSON Schema for factory.config.ts",
    run: async () => {
      console.log(JSON.stringify(jsonSchema(), null, 2));
      return 0;
    },
  },
  migrate: { summary: "Upgrade factory.config.ts to this release's configVersion", run: migrate },
  timesheet: {
    summary:
      "File the shift's timesheet row ([<session-id>] [--dry-run]), or --report the last 7 and 30 days",
    run: timesheet,
  },
  memo: {
    summary:
      "File the shift's section on this machine's memo for the day (<input.json> [--dry-run] [--run-dir <path>])",
    run: memo,
  },
  untriaged: { summary: "List the open tickets the receptionist has yet to route", run: untriaged },
  mobile: {
    summary:
      "device: whether this machine runs device checks; native <base> [<head>]: what needs a new dev build",
    run: mobile,
  },
  version: {
    summary: "Print the factory release",
    run: async () => {
      console.log(FACTORY_VERSION);
      return 0;
    },
  },
  free: {
    summary:
      "List the free tickets a shift takes, in order ([--department <d>]... [--kind <k>]... [--order <o>] [--mobile])",
    run: free,
  },
  claim: {
    summary: "Claim a free ticket for its branch on this machine (<n> <branch>)",
    run: claim,
  },
  "in-flight": {
    summary: "List this machine's claims with the step each resumes at ([--run-dir <path>])",
    run: inFlight,
  },
  park: {
    summary:
      "Park a ticket for a decision, keeping its work (<n> [--reason <text>] [--run-dir <path>])",
    run: park,
  },
  push: {
    summary:
      "Push a reviewed branch and open its PR (<n> --auto-merge on|off [--shots <dir>] [--title <text>])",
    run: push,
  },
  inspectors: {
    summary: "List the axes quality control inspects this branch on ([<base>])",
    run: inspectors,
  },
  clean: { summary: "Remove the worktrees and branches of merged PRs ([--dry-run])", run: clean },
  "epic-close": {
    summary: "Drop a closed ticket's claim and note it on its epic, closing the epic when done",
    run: epicClose,
  },
  "comment-edit": {
    summary: "Replace your last comment on a ticket or PR (<issue|pr> <n> --body-file <file>)",
    run: commentEdit,
  },
  "stop-e2e": {
    summary: "Stop what a stopped agent left running in its worktree (<worktree>)",
    run: stopE2e,
  },
  timings: {
    summary:
      "Show what's overdue and each step's median, or mark one ([--watch | start|end <step>])",
    run: timings,
  },
  usage: {
    summary: "Each agent's minutes and tokens in a shift ([<session-id>] [--json])",
    run: usage,
  },
  calls: {
    summary: "A shift's tool calls, slowest and largest ([<session-id>] [--json])",
    run: calls,
  },
  "suggestion-box": {
    summary:
      "Drop a shift's notes in the suggestion box, or list the unreviewed (drop <file> | list)",
    run: suggestionBox,
  },
  "review-due": { summary: "Print due when a performance review is due", run: reviewDue },
  "review-done": {
    summary: "Record a performance review (--through <entry> [<pr-url>...])",
    run: reviewDone,
  },
};

function help(): number {
  console.log(`factory ${FACTORY_VERSION}\n\nUsage: factory <command>\n`);
  for (const [name, { summary }] of Object.entries(COMMANDS))
    console.log(`  ${name.padEnd(16)}${summary}`);
  return 0;
}

const [name, ...args] = process.argv.slice(2);
const command = name && COMMANDS[name];
try {
  if (command) process.exitCode = await command.run(args);
  else
    process.exitCode = help() || Number(Boolean(name) && !["help", "--help", "-h"].includes(name!));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
