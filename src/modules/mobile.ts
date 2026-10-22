import { matchesGlob } from "node:path";

import type { Exec } from "../runtime/exec.ts";
import { type MachineConfig, mobileSignoff } from "../runtime/machine.ts";
import type { Mobile, Modules } from "./schema.ts";

const dependencies = (manifest: string): Record<string, string> => {
  if (!manifest) return {};
  return (JSON.parse(manifest) as { dependencies?: Record<string, string> }).dependencies ?? {};
};

/** Each dependency the pnpm lockfile lists for the importer at app, as its specifier and version without the peer suffix. */
export function lockedImporter(lockfile: string, app: string): Map<string, string> {
  const entries = new Map<string, string>();
  let inside = false;
  let name: string | undefined;
  for (const line of lockfile.split("\n")) {
    if (/^ {0,2}\S/.test(line)) {
      inside = line === `  ${app}:`;
      continue;
    }
    if (!inside) continue;
    const key = /^ {6}'?(.+?)'?:$/.exec(line);
    const field = /^ {8}(?:specifier|version): ([^(]*)/.exec(line);
    if (key) name = key[1];
    if (field && name) entries.set(name, `${entries.get(name) ?? ""} ${field[1]}`.trim());
  }
  return entries;
}

/** The app's dependencies at ref, each as the lockfile resolves it, or as package.json asks when the lockfile doesn't. */
function appDependencies(mobile: Mobile, ref: string, sh: Exec): Record<string, string> {
  const show = (file: string) => sh("git", ["show", `${ref}:${file}`]).stdout;
  const locked = lockedImporter(show("pnpm-lock.yaml"), mobile.app);
  return Object.fromEntries(
    Object.entries(dependencies(show(`${mobile.app}/package.json`))).map(([name, wanted]) => [
      name,
      locked.get(name) ?? wanted,
    ]),
  );
}

/** Why a dev build of one commit can't run the other: each changed file a `native` glob matches, and each app dependency added, moved or removed between them, in either direction. Undefined when git can't diff them. */
export function nativeBetween(
  mobile: Mobile,
  from: string,
  to: string,
  sh: Exec,
): string[] | undefined {
  const diff = sh("git", ["diff", "--name-only", "--no-renames", from, to]);
  if (diff.status !== 0) return undefined;
  const files = diff.stdout
    .split("\n")
    .filter((file) => file && mobile.native.some((glob) => matchesGlob(file, glob)));
  const [before, after] = [from, to].map((ref) => appDependencies(mobile, ref, sh));
  const moved = [...new Set([...Object.keys(after!), ...Object.keys(before!)])]
    .filter((name) => before![name] !== after![name])
    .map(
      (name) =>
        `${mobile.app}/package.json: ${name} ${before![name] ?? "added"} → ${after![name] ?? "removed"}`,
    );
  return [...files, ...moved];
}

/** Why base...head needs a new dev build; empty when it needs none, undefined when git can't read the range. */
export function nativeChanges(
  mobile: Mobile,
  base: string,
  head: string,
  sh: Exec,
): string[] | undefined {
  const fork = sh("git", ["merge-base", base, head]);
  return fork.status === 0 ? nativeBetween(mobile, fork.stdout.trim(), head, sh) : undefined;
}

/** Why this machine can't run the project's device checks; undefined when it can. */
export function notDeviceMachine(
  mobile: Modules["mobile"],
  machine: MachineConfig,
): string | undefined {
  if (mobile === "none") return "the mobile module is none in factory.config.ts";
  if (!mobileSignoff(machine))
    return "this machine is not the device machine: set MOBILE_SIGNOFF=on in ~/.factory/machine on the one with the simulator";
  return undefined;
}
