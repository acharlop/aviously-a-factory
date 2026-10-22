import { z } from "zod";

import { FACTORY_LABELS } from "../labels.ts";
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

const paperTrail = z
  .union([
    z.literal("none").describe("This project keeps no paper trail"),
    z.strictObject({
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name")
        .describe("owner/name of the repository the File step writes to"),
      timesheet: z
        .string()
        .min(1)
        .default("timesheets/shifts.jsonl")
        .describe(
          "Path of the timesheet: one JSON line per shift, its table in README.md beside it",
        ),
      signOffs: z
        .string()
        .min(1)
        .default("sign-offs")
        .describe("Folder for sign-offs: one JSON file each, in a folder per day"),
      memoLabel: z
        .string()
        .min(1)
        .default("memo")
        .describe("Label on each memo, an issue in the repository per machine per day"),
    }),
  ])
  .default("none")
  .describe("Where the File step writes timesheets, memos and sign-offs");

const fields = {
  configVersion: z.literal(CONFIG_VERSION),
  departments: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .default([])
    .describe("The departments tickets are filed under, each a department:<name> label"),
  steps: z
    .record(z.string(), stepPin)
    .default({})
    .describe("The version each step runs at. A step left out runs at its oldest live version"),
  paperTrail,
  labelRenames: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'Old label names this project renames to factory labels, beyond the factory\'s own list, e.g. { factory: "kind:tooling" }',
    ),
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
    for (const [from, to] of Object.entries(config.labelRenames))
      if (!FACTORY_LABELS.some((label) => label.name === to))
        ctx.addIssue({
          code: "custom",
          path: ["labelRenames", from],
          message: `"${to}" is not a factory label; known: ${FACTORY_LABELS.map((label) => label.name).join(", ")}`,
        });
  });

export const configSchema = schemaFor(STEP_VERSIONS);

/** What a project writes in factory.config.ts. */
export type FactoryConfigInput = z.input<typeof configSchema>;
export type FactoryConfig = z.output<typeof configSchema>;
export type PaperTrail = Exclude<FactoryConfig["paperTrail"], "none">;

export const jsonSchema = () =>
  z.toJSONSchema(configSchema, { io: "input", unrepresentable: "any" });
