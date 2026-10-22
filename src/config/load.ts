import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { findStep, STEP_VERSIONS, stepNames } from "../steps/registry.ts";
import type { StepVersion } from "../steps/step.ts";
import { FACTORY_VERSION } from "../version.ts";
import { configSchema, type FactoryConfig, type PaperTrail } from "./schema.ts";

export const CONFIG_FILE = "factory.config.ts";
export const RESOLVED_FILE = join(".factory", "resolved.json");

/** The nearest directory at or above `from` holding factory.config.ts. */
export function findProjectRoot(from = process.cwd()): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export class ConfigError extends Error {}

/** The project's config as authored, before validation. */
export async function readRawConfig(root: string): Promise<unknown> {
  const url = pathToFileURL(join(root, CONFIG_FILE));
  url.search = `?t=${Date.now()}`;
  const module = (await import(url.href)) as { default?: unknown };
  if (module.default === undefined) throw new ConfigError(`${CONFIG_FILE} has no default export`);
  return module.default;
}

export function parseConfig(raw: unknown, schema = configSchema): FactoryConfig {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(`${CONFIG_FILE} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export type ResolvedStep =
  | { version: number; summary: string; deprecated?: string }
  | { local: string }
  | "none";

/** What hooks and agents read: every step settled to one version, a local path, or none. */
export type Resolved = {
  factoryVersion: string;
  configVersion: number;
  root: string;
  steps: Record<string, ResolvedStep>;
  paperTrail: PaperTrail | "none";
};

/** The version an unpinned step runs: its oldest live one, so a factory upgrade never changes it unasked. */
function defaultVersion(name: string, registry: readonly StepVersion[]): number {
  const versions = registry.filter((step) => step.name === name);
  const live = versions.filter((step) => !step.deprecated);
  return Math.min(...(live.length ? live : versions).map((step) => step.version));
}

export function resolveConfig(
  config: FactoryConfig,
  root: string,
  registry = STEP_VERSIONS,
): Resolved {
  const steps: Record<string, ResolvedStep> = {};
  for (const name of stepNames(registry)) {
    const pin = config.steps[name] ?? defaultVersion(name, registry);
    if (pin === "none") steps[name] = "none";
    else if (typeof pin === "object") steps[name] = { local: resolve(root, pin.local) };
    else {
      const { summary, deprecated } = findStep(name, pin, registry)!;
      steps[name] = { version: pin, summary, ...(deprecated && { deprecated }) };
    }
  }
  return {
    factoryVersion: FACTORY_VERSION,
    configVersion: config.configVersion,
    root,
    steps,
    paperTrail: config.paperTrail,
  };
}

/** Loads, validates and resolves the project's config, and rewrites .factory/resolved.json when it changed. */
export async function loadProject(from = process.cwd()) {
  const root = findProjectRoot(from);
  if (!root) throw new ConfigError(`no ${CONFIG_FILE} here or above ${resolve(from)}`);
  const resolved = resolveConfig(parseConfig(await readRawConfig(root)), root);
  const file = join(root, RESOLVED_FILE);
  const text = `${JSON.stringify(resolved, null, 2)}\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return resolved;
}
