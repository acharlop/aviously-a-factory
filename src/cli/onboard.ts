import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_FILE, parseConfig, readRawConfig } from "../config/load.ts";
import { listLabels } from "../labels.ts";
import { configText, detect, planLines, starterConfig } from "../onboarding.ts";
import { exec, type Exec } from "../runtime/exec.ts";

/** `factory onboard [--write]`: the plan for setting this project up for the factory; --write writes the starter factory.config.ts, never over one. */
export async function onboard(args: string[], sh: Exec = exec, from = process.cwd()) {
  if (args.some((arg) => arg !== "--write")) {
    console.log("usage: factory onboard [--write]");
    return 2;
  }
  const top = sh("git", ["rev-parse", "--show-toplevel"], { cwd: from });
  if (top.status !== 0) {
    console.log("factory onboard runs in a git checkout of the project");
    return 1;
  }
  const root = top.stdout.trim();
  const here: Exec = (command, rest, options) => sh(command, rest, { cwd: root, ...options });
  const facts = detect(root, here);
  const file = join(root, CONFIG_FILE);
  const exists = existsSync(file);
  const config = exists
    ? parseConfig(await readRawConfig(root))
    : parseConfig(starterConfig(facts));
  const text = exists ? readFileSync(file, "utf8") : configText(starterConfig(facts));
  if (!exists && args.includes("--write")) {
    writeFileSync(file, text);
    console.log(`wrote ${CONFIG_FILE}\n`);
  }
  const lines = planLines(
    facts,
    { ...config, text, written: exists || args.includes("--write") },
    listLabels(here),
  );
  for (const line of lines) console.log(line);
  return 0;
}
