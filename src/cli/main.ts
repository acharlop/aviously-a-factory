#!/usr/bin/env node
import { ConfigError, loadProject } from "../config/load.ts";
import { jsonSchema } from "../config/schema.ts";
import { FACTORY_VERSION } from "../version.ts";
import { doctor } from "./doctor.ts";
import { migrate } from "./migrate.ts";

const COMMANDS: Record<string, { summary: string; run: (args: string[]) => Promise<number> }> = {
  doctor: { summary: "Check the config, the plugin and this machine", run: doctor },
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
    console.log(`  ${name.padEnd(10)}${summary}`);
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
