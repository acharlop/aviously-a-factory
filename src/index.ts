import type { FactoryConfigInput } from "./config/schema.ts";

/** Typed identity: `export default defineConfig({ ... })` in factory.config.ts. */
export const defineConfig = (config: FactoryConfigInput) => config;

export type { FactoryConfig, FactoryConfigInput, PaperTrail } from "./config/schema.ts";
export type { Resolved, ResolvedStep } from "./config/load.ts";
export { oneDecimal, sampleUsage, signOffRecorder } from "./steps/file/v1/sign-off.ts";
export type { CheckStats, Recorder, SignOff } from "./steps/file/v1/sign-off.ts";
