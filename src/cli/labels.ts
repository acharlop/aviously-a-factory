import { parseArgs } from "node:util";

import {
  CONFIG_FILE,
  ConfigError,
  findProjectRoot,
  parseConfig,
  readRawConfig,
} from "../config/load.ts";
import { applyChange, describeChange, listLabels, planLabels } from "../labels.ts";
import { exec, type Exec } from "../runtime/exec.ts";

export async function labels(
  args: string[],
  sh: Exec = exec,
  from = process.cwd(),
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { apply: { type: "boolean", default: false }, repo: { type: "string" } },
  });
  const root = findProjectRoot(from);
  if (!root) throw new ConfigError(`no ${CONFIG_FILE} here or above ${from}`);
  const { labelRenames } = parseConfig(await readRawConfig(root));
  const changes = planLabels(listLabels(sh, values.repo), labelRenames);
  if (changes.length === 0) {
    console.log("labels match the factory set");
    return 0;
  }
  for (const change of changes) {
    console.log(describeChange(change));
    if (values.apply) applyChange(change, sh, values.repo);
  }
  if (!values.apply) console.log("\ndry run: --apply makes these changes");
  return 0;
}
