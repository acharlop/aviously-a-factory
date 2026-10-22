import { CONFIG_FILE, findProjectRoot, readRawConfig } from "../config/load.ts";
import { CONFIG_VERSION } from "../config/schema.ts";

/** Each entry upgrades a config from its key's version to the next, editing factory.config.ts in place. */
export const MIGRATIONS: Record<number, (root: string) => void> = {};

export async function migrate(): Promise<number> {
  const root = findProjectRoot();
  if (!root) {
    console.error(`no ${CONFIG_FILE} here or above`);
    return 1;
  }
  const raw = (await readRawConfig(root)) as { configVersion?: unknown };
  let version = Number(raw.configVersion);
  if (!Number.isInteger(version) || version > CONFIG_VERSION) {
    console.error(
      `configVersion ${String(raw.configVersion)} is not one this factory (config v${CONFIG_VERSION}) reads`,
    );
    return 1;
  }
  for (; version < CONFIG_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (!step) {
      console.error(`no migration from configVersion ${version}`);
      return 1;
    }
    step(root);
  }
  console.log(`${CONFIG_FILE} is at configVersion ${CONFIG_VERSION}`);
  return 0;
}
