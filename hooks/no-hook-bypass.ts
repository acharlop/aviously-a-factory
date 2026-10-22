// PreToolUse hook on Bash: refuses a git command that skips the repo's hooks, and an admin merge that skips the merge gate. A guard for cooperative agents, not a sandbox.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const refused = (what: string) =>
  `Refused: ${what} skips the repo's git hooks. Fix what the hook reports; if it can't pass, stop and say why.`;
const NO_VERIFY = refused("--no-verify");
const HOOKS_PATH = refused("overriding core.hooksPath");
const ADMIN_MERGE =
  "Refused: `gh pr merge --admin` skips the merge queue and the gate's checks. Turn auto-merge on and let the queue land it; a by-hand merge is run by a person, not an agent.";

// git's global options that take the next word as their value.
const GLOBAL_VALUE = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree"]);
// gh's global option that takes the next word as its value.
const GH_GLOBAL_VALUE = new Set(["-R", "--repo"]);
// git commit's short options that take a value, so a later "n" in the same word is that value.
const COMMIT_VALUE = new Set(["m", "F", "c", "C", "t", "S", "u"]);

// A heredoc's body, from the line after its marker to its tag alone on a line.
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?(?:\n\t*\3(?=\n|$)|$)/g;
// A quoted string, an escaped character, a comment, a command separator, blanks, or a run of plain characters.
const TOKEN =
  /'([^']*)'?|"((?:\\[\s\S]|[^"\\])*)"?|\\([\s\S]?)|(?<![^\s;&|()])#.*|[;&|()\n]|[ \t]+|[^\s'"\\;&|()]+/g;

/** The words of each simple command in a shell script, quotes resolved, comments and heredoc bodies dropped. */
function commands(script: string): string[][] {
  const out: string[][] = [[]];
  let word: string | undefined;
  for (const [token, single, double, escaped] of `${script}\n`
    .replace(HEREDOC, "$1")
    .replaceAll("\\\n", "")
    .matchAll(TOKEN)) {
    if (/^[\s;&|()]/.test(token) || (token[0] === "#" && word === undefined)) {
      if (word !== undefined) out.at(-1)!.push(word);
      word = undefined;
      if (/^[;&|()\n]$/.test(token)) out.push([]);
    } else
      word = (word ?? "") + (single ?? double?.replace(/\\(["\\$`])/g, "$1") ?? escaped ?? token);
  }
  return out.filter((words) => words.length > 0);
}

function gitRefusal(args: readonly string[], hooksPath: string | undefined): string | undefined {
  let at = 0;
  for (; args[at]?.startsWith("-"); at += GLOBAL_VALUE.has(args[at]!) ? 2 : 1) {
    const setting = args[at] === "-c" || args[at] === "--config-env" ? args[at + 1] : args[at];
    if (/^(--config-env=)?core\.hookspath(=|$)/i.test(setting ?? "")) return HOOKS_PATH;
  }
  const [subcommand, ...rest] = args.slice(at);
  const options = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  // git takes any unambiguous prefix of a long option.
  if (options.some((arg) => /^--no-veri(fy?)?$/.test(arg))) return NO_VERIFY;
  for (const arg of subcommand === "commit" ? options.filter((o) => /^-[^-]/.test(o)) : [])
    for (const flag of arg.slice(1)) {
      if (flag === "n") return NO_VERIFY;
      if (COMMIT_VALUE.has(flag)) break;
    }
  const key = rest.findIndex((arg) => /^core\.hookspath$/i.test(arg));
  const value = key < 0 ? undefined : rest[key + 1];
  // Unsetting falls back to .git/hooks, which has none of the repo's hooks.
  const unset = key >= 0 && rest.some((arg) => /^(--unset(-all)?|unset)$/.test(arg));
  if (subcommand === "config" && (unset || (value !== undefined && value !== hooksPath)))
    return HOOKS_PATH;
  return undefined;
}

function ghRefusal(args: readonly string[]): string | undefined {
  let at = 0;
  for (; args[at]?.startsWith("-"); at += GH_GLOBAL_VALUE.has(args[at]!) ? 2 : 1);
  const [group, command, ...rest] = args.slice(at);
  const options = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (
    group === "pr" &&
    command === "merge" &&
    options.some((arg) => /^--admin(=(?!false$)|$)/.test(arg))
  )
    return ADMIN_MERGE;
  return undefined;
}

/** Why a Bash command may not run, or undefined when it may. `hooksPath` is the repo's own core.hooksPath, which may be set again. */
export function refusal(script: string, hooksPath?: string): string | undefined {
  return commands(script)
    .map((words) => words.slice(words.findIndex((word) => !/^\w+=/.test(word))))
    .map(([program, ...args]) => {
      const name = basename(program ?? "");
      return name === "git"
        ? gitRefusal(args, hooksPath)
        : name === "gh"
          ? ghRefusal(args)
          : undefined;
    })
    .find(Boolean);
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    cwd?: unknown;
    tool_input?: { command?: unknown };
  };
  const command = input.tool_input?.command;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const hooksPath =
    spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd,
      encoding: "utf8",
    }).stdout?.trim() || undefined;
  const reason = typeof command === "string" ? refusal(command, hooksPath) : undefined;
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}
