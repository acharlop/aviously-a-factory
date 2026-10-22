import { z } from "zod";

import { findStep, STEP_VERSIONS, stepNames } from "../steps/registry.ts";
import type { StepVersion } from "../steps/step.ts";

/** The config major this release reads. `factory migrate` upgrades older ones. */
export const CONFIG_VERSION = 1;

const stepPin = z.union([
  z.number().int().positive().describe("The step version to run, e.g. 2 for review@2"),
  z.literal("none").describe("This project skips the step"),
  z
    .strictObject({
      local: z.string().min(1).describe("Path to the project's own step, from the project root"),
    })
    .describe("A local step: the project supplies this step itself"),
]);

const fields = {
  configVersion: z.literal(CONFIG_VERSION),
  steps: z
    .record(z.string(), stepPin)
    .default({})
    .describe("The version each step runs at. A step left out runs at its oldest live version"),
};

/** The config schema, checking step pins against `registry`. */
export const schemaFor = (registry: readonly StepVersion[]) =>
  z.strictObject(fields).superRefine((config, ctx) => {
    const known = stepNames(registry);
    for (const [name, pin] of Object.entries(config.steps)) {
      const path = ["steps", name];
      if (!known.includes(name))
        ctx.addIssue({
          code: "custom",
          path,
          message: `no step called "${name}"; known: ${known.join(", ") || "none yet"}`,
        });
      else if (typeof pin === "number" && !findStep(name, pin, registry))
        ctx.addIssue({
          code: "custom",
          path,
          message: `${name}@${pin} does not exist in this factory release`,
        });
    }
  });

export const configSchema = schemaFor(STEP_VERSIONS);

/** What a project writes in factory.config.ts. */
export type FactoryConfigInput = z.input<typeof configSchema>;
export type FactoryConfig = z.output<typeof configSchema>;

export const jsonSchema = () =>
  z.toJSONSchema(configSchema, { io: "input", unrepresentable: "any" });
