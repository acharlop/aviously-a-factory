import { mobileModule } from "./mobile-check.ts";
import type { Module } from "./module.ts";

export type { Fixup, Module, ModuleContext } from "./module.ts";

/** Every module this release ships. Each lives in modules/<name>. */
export const MODULES: readonly Module[] = [mobileModule];

export const findModule = (name: string, modules = MODULES) =>
  modules.find((module) => module.name === name);
