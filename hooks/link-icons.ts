// PreToolUse hook on Bash: refuses a gh write whose text links an issue with the PR icon or a PR with the issue icon. A guard for cooperative agents, not a sandbox.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// gh writes that carry a body, and the factory's comment edit, by command or by a project's `factory:` alias.
const WRITE =
  /(?:^|[\s;&|(])(?:gh\s+(?:(?:-R|--repo)[\s=]\S+\s+)?(?:(?:issue|pr)\s+(?:create|comment|edit|review|close|merge)\b|api\b)|factory[:\s]\s*comment-edit\b)/;
const LINK = /\[#\d+\s*(🔀|📋)\]\((https?:\/\/[^)\s]+)\)/gu;
const BODY_FILE = /--body-file[\s=](?:'([^']+)'|"([^"]+)"|(\S+))/g;
const LEADING_CD = /^\s*cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))\s*&&/;

/** The text a command writes: the command itself, plus each body file it names. */
function written(script: string, cwd: string): string {
  const cd = LEADING_CD.exec(script);
  const base = cd ? resolve(cwd, cd[1] ?? cd[2] ?? cd[3]!) : cwd;
  const files = [...script.matchAll(BODY_FILE)]
    .map(([, single, double, plain]) => single ?? double ?? plain!)
    .filter((file) => file !== "-")
    .map((file) => resolve(base, file))
    .filter((file) => existsSync(file));
  return [script, ...files.map((file) => readFileSync(file, "utf8"))].join("\n");
}

/** Why a Bash command may not run, or undefined when it may. */
export function refusal(script: string, cwd = process.cwd()): string | undefined {
  if (!WRITE.test(script)) return undefined;
  for (const [link, icon, url] of written(script, cwd).matchAll(LINK)) {
    if (icon === "🔀" && /\/issues\/\d/.test(url!))
      return `Refused: ${link} links an issue with the PR icon; an issue takes 📋.`;
    if (icon === "📋" && /\/pull\/\d/.test(url!))
      return `Refused: ${link} links a pull request with the issue icon; a pull request takes 🔀.`;
  }
  return undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    cwd?: unknown;
    tool_input?: { command?: unknown };
  };
  const command = input.tool_input?.command;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const reason = typeof command === "string" ? refusal(command, cwd) : undefined;
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}
