import type { FactoryConfigInput } from "./config/schema.ts";

/** Typed identity: `export default defineConfig({ ... })` in factory.config.ts. */
export const defineConfig = (config: FactoryConfigInput) => config;

export type { FactoryConfig, FactoryConfigInput } from "./config/schema.ts";
export type { Resolved, ResolvedStep } from "./config/load.ts";
