import type { Check } from "../runtime/checks.ts";
import type { Exec } from "../runtime/exec.ts";
import type { MachineConfig } from "../runtime/machine.ts";
import type { Modules } from "./schema.ts";

/** What a module's hooks are built with: the project's checkout, its modules' settings, this machine's config and folder for the project, and the shell. */
export type ModuleContext = {
  root: string;
  modules: Modules;
  machine: MachineConfig;
  home: string;
  sh: Exec;
};

/** Run in the merge queue's clone while main is being merged into a head, with the merge uncommitted and any conflicts in place: mends what it can, and says why the head can't land, or undefined. */
export type Fixup = (at: {
  dir: string;
  main: string;
  head: string;
}) => Promise<string | undefined>;

/** An optional capability a project switches on by naming it in factory.config.ts, such as mobile. */
export type Module = {
  name: string;
  summary: string;
  /** The check a project gets with `gate.checks.<name>: { module: "<this module>" }`. */
  check?: (name: string, context: ModuleContext) => Check;
  /** The fixup a project gets with `merge.fixups: [{ module: "<this module>" }]`. */
  fixup?: (context: ModuleContext) => Fixup;
};
