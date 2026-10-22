import { matchesGlob } from "node:path";

import type { Resolved } from "../config/load.ts";
import type { Exec } from "../runtime/exec.ts";
import { type MachineConfig, mobileSignoff } from "../runtime/machine.ts";
import type { Mobile } from "./schema.ts";

const dependencies = (manifest: string): Record<string, string> => {
  if (!manifest) return {};
  return (JSON.parse(manifest) as { dependencies?: Record<string, string> }).dependencies ?? {};
};

/**
 * Why base...head needs a new dev build: each changed file a `native` glob matches, and each
 * app dependency added or bumped. Empty when it needs none; undefined when git can't read the range.
 */
export function nativeChanges(
  mobile: Mobile,
  base: string,
  head: string,
  sh: Exec,
): string[] | undefined {
  const fork = sh("git", ["merge-base", base, head]);
  if (fork.status !== 0) return undefined;
  const from = fork.stdout.trim();
  const diff = sh("git", ["diff", "--name-only", from, head]);
  if (diff.status !== 0) return undefined;
  const files = diff.stdout
    .split("\n")
    .filter((file) => file && mobile.native.some((glob) => matchesGlob(file, glob)));
  const manifest = (ref: string) => sh("git", ["show", `${ref}:${mobile.app}/package.json`]).stdout;
  const before = dependencies(manifest(from));
  const bumped = Object.entries(dependencies(manifest(head)))
    .filter(([name, version]) => before[name] !== version)
    .map(
      ([name, version]) =>
        `${mobile.app}/package.json: ${name} ${before[name] ?? "added"} → ${version}`,
    );
  return [...files, ...bumped];
}

/** Why this machine can't run the project's device checks; undefined when it can. */
export function notDeviceMachine(resolved: Resolved, machine: MachineConfig): string | undefined {
  if (resolved.modules.mobile === "none") return "the mobile module is none in factory.config.ts";
  if (!mobileSignoff(machine))
    return "this machine is not the device machine: set MOBILE_SIGNOFF=on in ~/.factory/machine on the one with the simulator";
  return undefined;
}
