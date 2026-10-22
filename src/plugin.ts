import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_NAME = "aviously-a-factory";

type Install = { scope: string; projectPath?: string; version: string };

/**
 * The factory plugin version Claude Code runs for this project: the plugin that invoked us
 * (CLAUDE_PLUGIN_ROOT), else a project-scoped install for `root`, else a user-scoped one.
 */
export function installedPluginVersion(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  claudeHome = join(homedir(), ".claude"),
): string | undefined {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
  const manifest = pluginRoot && join(pluginRoot, ".claude-plugin", "plugin.json");
  if (manifest && existsSync(manifest)) {
    const plugin = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; version: string };
    if (plugin.name === PLUGIN_NAME) return plugin.version;
  }
  const registry = join(claudeHome, "plugins", "installed_plugins.json");
  if (!existsSync(registry)) return undefined;
  const { plugins } = JSON.parse(readFileSync(registry, "utf8")) as {
    plugins: Record<string, Install[]>;
  };
  const installs = Object.entries(plugins)
    .filter(([key]) => key.split("@")[0] === PLUGIN_NAME)
    .flatMap(([, list]) => list);
  return (
    installs.find((install) => install.scope !== "user" && install.projectPath === root) ??
    installs.find((install) => install.scope === "user")
  )?.version;
}
