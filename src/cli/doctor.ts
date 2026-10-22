import { RESOLVED_FILE, loadProject } from "../config/load.ts";
import { installedPluginVersion } from "../plugin.ts";
import { FACTORY_VERSION } from "../version.ts";

export type Check = { name: string; ok: boolean; detail: string };

const MIN_NODE = [24, 15];

export function nodeCheck(version = process.versions.node): Check {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok = major > MIN_NODE[0]! || (major === MIN_NODE[0] && minor >= MIN_NODE[1]!);
  return {
    name: "node",
    ok,
    detail: ok ? `v${version}` : `v${version}; the factory needs ${MIN_NODE.join(".")} or later`,
  };
}

export function pluginCheck(installed: string | undefined, cli = FACTORY_VERSION): Check {
  if (!installed)
    return {
      name: "plugin",
      ok: false,
      detail: "the aviously-a-factory plugin is not installed for this project",
    };
  return installed === cli
    ? { name: "plugin", ok: true, detail: `${installed}, same as the CLI` }
    : {
        name: "plugin",
        ok: false,
        detail: `plugin is ${installed} but the CLI is ${cli}; update whichever is behind`,
      };
}

/** Every check doctor runs against a project; doctor fails when any of them does. */
export async function checks(from = process.cwd()): Promise<Check[]> {
  const results = [nodeCheck()];
  try {
    const resolved = await loadProject(from);
    const deprecated = Object.entries(resolved.steps).filter(
      ([, step]) => typeof step === "object" && "deprecated" in step,
    );
    results.push({ name: "config", ok: true, detail: `valid, resolved to ${RESOLVED_FILE}` });
    for (const [name, step] of deprecated)
      results.push({
        name: `step ${name}`,
        ok: true,
        detail: `deprecated: ${(step as { deprecated: string }).deprecated}`,
      });
    results.push(pluginCheck(installedPluginVersion(resolved.root)));
  } catch (error) {
    results.push({ name: "config", ok: false, detail: (error as Error).message });
  }
  return results;
}

export async function doctor(): Promise<number> {
  const results = await checks();
  for (const { name, ok, detail } of results)
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  return results.every((check) => check.ok) ? 0 : 1;
}
