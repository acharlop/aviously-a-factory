import { readFileSync } from "node:fs";

/** Resolves from src/ and dist/ alike: both sit one level under the package root. */
export const PACKAGE_ROOT = new URL("..", import.meta.url);

const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(path, PACKAGE_ROOT), "utf8")) as { version: string };

/** The factory release this CLI is. */
export const FACTORY_VERSION = readJson("package.json").version;

/** The version the bundled plugin manifest declares; a release keeps it equal to FACTORY_VERSION. */
export const pluginManifestVersion = () => readJson(".claude-plugin/plugin.json").version;
