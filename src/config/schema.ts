import { z } from "zod";

import { FACTORY_LABELS } from "../labels.ts";
import { findModule } from "../modules/registry.ts";
import { modules } from "../modules/schema.ts";
import { TIMEOUT_KEYS } from "../runtime/machine.ts";
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
      suggestionBox: z
        .string()
        .min(1)
        .default("suggestion-box")
        .describe(
          "Folder for the suggestion box: each shift's notes in a folder per day, and reviews.jsonl, one line per performance review",
        ),
    }),
  ])
  .default("none")
  .describe("Where the File step writes timesheets, memos and sign-offs");

const globs = (what: string) => z.array(z.string().min(1)).default([]).describe(what);

const foreman = z
  .strictObject({
    setup: z
      .string()
      .min(1)
      .optional()
      .describe("Runs in each new worktree before its temp starts, e.g. pnpm wt:setup"),
    teardown: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Runs in a merged worktree before factory clean removes it, e.g. to drop its databases",
      ),
    security: globs(
      "Globs, from the project root, of files whose change also gets the security inspector",
    ),
    migrations: globs(
      "Globs of schema files whose change needs a migration generated before factory push",
    ),
    heavy: z
      .array(z.string().min(1))
      .default([])
      .describe("Commands factory calls counts on rows of their own, e.g. pnpm e2e:spec"),
  })
  .default({ security: [], migrations: [], heavy: [] })
  .describe("How the foreman sets up worktrees, picks inspectors and pushes");

const when = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "Globs of changed files that need this check, `!` excluding; any change past docs when left out",
  );

const check = z.union([
  z.strictObject({
    run: z
      .string()
      .min(1)
      .describe(
        "Shell command that runs the check in the change's checkout; the units `select` printed follow it as arguments",
      ),
    select: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Shell command run in the change's checkout with the base commit as its argument, printing the units the change needs, one per line (spec files, say); printing none means the change needs no run",
      ),
    when,
    timeout: z
      .enum(TIMEOUT_KEYS)
      .default("TIMEOUT_VERIFY")
      .describe("The machine config key whose minutes bound one run"),
    tries: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe("Runs a failing unit gets; one that fails and then passes is flaky"),
  }),
  z.strictObject({
    module: z
      .string()
      .refine((name) => findModule(name)?.check, "no module by that name supplies a check")
      .describe("The module that supplies this check, such as mobile"),
    when,
  }),
]);

const gate = z
  .strictObject({
    base: z.string().min(1).default("main").describe("The branch changes merge into"),
    checks: z
      .record(z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and dashes"), check)
      .default({})
      .describe("The checks the gate runs on a change, in order: each one is a verdict"),
    docs: z
      .array(z.string().min(1))
      .default(["docs/**", "**/*.md"])
      .describe("Globs of files that need no check, `!` excluding"),
    status: z
      .string()
      .min(1)
      .default("signoff/")
      .describe("Prefix of the commit status each check posts, as in signoff/web"),
  })
  .prefault({})
  .describe("The gate: the checks a change passes before it merges");

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
  modules,
  foreman,
  gate,
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
export type Foreman = FactoryConfig["foreman"];
export type Gate = FactoryConfig["gate"];

export const jsonSchema = () =>
  z.toJSONSchema(configSchema, { io: "input", unrepresentable: "any" });
