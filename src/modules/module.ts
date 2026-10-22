import type { Check } from "../runtime/checks.ts";
import type { Exec } from "../runtime/exec.ts";
import type { MachineConfig } from "../runtime/machine.ts";

/** What a module's hooks are built with: the project's checkout, this machine's config for the project, and the shell. */
export type ModuleContext = { root: string; machine: MachineConfig; sh: Exec };

/** An optional capability a project switches on by naming it in factory.config.ts, such as mobile. */
export type Module = {
  name: string;
  summary: string;
  /** The check a project gets with `gate.checks.<name>: { module: "<this module>" }`. */
  check?: (name: string, context: ModuleContext) => Check;
};
