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
};

function help(): number {
  console.log(`factory ${FACTORY_VERSION}\n\nUsage: factory <command>\n`);
  for (const [name, { summary }] of Object.entries(COMMANDS))
    console.log(`  ${name.padEnd(11)}${summary}`);
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
