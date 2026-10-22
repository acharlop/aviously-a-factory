import { z } from "zod";

const path = (what: string) => z.string().min(1).describe(`${what}, from the project root`);
const command = (what: string) => z.string().min(1).describe(what);
const locale = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/, "a locale such as en or pt-BR");

const translations = z.strictObject({
  source: locale.default("en").describe("The locale the copy desk writes first"),
  locales: z
    .array(locale)
    .min(1)
    .describe("Every other locale the copy desk translates into, e.g. he, ar, ru, fr"),
  catalog: path("Path of one locale's message catalog, with {locale} where the locale goes").regex(
    /\{locale\}/,
    "must contain {locale}",
  ),
  copyRules: path("The project's copy rules, which the English is rewritten to"),
  glossary: path("The term list every locale must use").optional(),
  changed: command("Lists the catalog keys a branch added or changed, with the base ref appended"),
  checks: z
    .array(command("A check the catalogs must pass"))
    .default([])
    .describe("Commands the copy desk runs before each commit, all of which must pass"),
});

const screenshots = z.strictObject({
  command: command("Takes screenshots of the changed screens into the folder in $SHOTS_DIR"),
  locales: z
    .array(locale)
    .min(1)
    .describe("The locales each screen is shot in; add a right-to-left one if the project has one"),
  references: path(
    "The doc naming the reference screens a new screen must look like; a ticket may name its own",
  ),
});

const mobile = z.strictObject({
  department: z
    .string()
    .min(1)
    .default("mobile")
    .describe("The department of tickets built on the machine with the simulator"),
  app: path("The mobile app's folder, whose package.json dependencies are native"),
  native: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Globs, from the project root, of files whose change needs a new dev build, e.g. apps/mobile/ios/**",
    ),
  startDevice: command("Starts a device check on this machine's simulator"),
  stopDevice: command("Stops the device check, whatever happened"),
  listFlows: command("Lists the end-to-end flows a branch reaches, without running them"),
  runFlows: command(
    "Runs the flows a branch reaches, with a folder appended for each flow's last screen",
  ),
});

const module = <T extends z.ZodType>(on: T, what: string) =>
  z
    .union([z.literal("none").describe("This project doesn't use the module"), on])
    .default("none")
    .describe(what);

export const modules = z
  .strictObject({
    translations: module(
      translations,
      "The copy desk settles the final English and every translation",
    ),
    screenshots: module(screenshots, "Changed screens are shot and judged by the looks inspector"),
    mobile: module(mobile, "Device checks on one simulator, and native changes left for a person"),
  })
  .default({ translations: "none", screenshots: "none", mobile: "none" })
  .describe("Optional capabilities the project switches on");

export type Modules = z.output<typeof modules>;
export type Translations = Exclude<Modules["translations"], "none">;
export type Screenshots = Exclude<Modules["screenshots"], "none">;
export type Mobile = Exclude<Modules["mobile"], "none">;
