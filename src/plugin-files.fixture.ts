import { existsSync, readFileSync } from "node:fs";

import { PACKAGE_ROOT } from "./version.ts";

export const pluginFileExists = (path: string) => existsSync(new URL(path, PACKAGE_ROOT));

export const pluginFile = (path: string) => readFileSync(new URL(path, PACKAGE_ROOT), "utf8");

/** The `key: value` lines of a plugin agent's or skill's frontmatter. */
export function frontmatter(path: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(pluginFile(path))?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

/** The markdown table under `## <heading>`, one trimmed string per row. */
export const tableUnder = (path: string, heading: string) =>
  (pluginFile(path).split(`## ${heading}\n`)[1] ?? "")
    .split("\n\n")
    .find((block) => block.startsWith("|"))
    ?.split("\n")
    .map((row) => row.replace(/\s+/g, " ").trim());
