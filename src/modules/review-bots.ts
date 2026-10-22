import { exec, type Exec } from "../runtime/exec.ts";
import { ghJson } from "../runtime/github.ts";
import { type OpenThread, openThreads } from "../runtime/reviews.ts";
import type { ReviewBots } from "./schema.ts";

type Said = { author: { login: string } | null; body: string };

/** What `gh pr view --json body,reviews,comments` says, oldest review and comment first. */
export type PrView = { body: string; reviews: Said[]; comments: Said[] };

/** Where one bot stands on a pull request. */
export type BotStanding = {
  name: string;
  reviewed: boolean;
  verdict?: string;
  passed: boolean;
  /** Its open threads, each a finding unless the bot is advisory. */
  open: string[];
  settled: boolean;
};

const loginOf = (login: string) => login.replace(/\[bot\]$/, "").toLowerCase();

/** Each bot's standing: reviewed once it has said anything; settled once it has, its verdict passes, and no thread of a findings bot is open. */
export function standings(
  bots: ReviewBots["bots"],
  view: PrView,
  threads: readonly OpenThread[],
): BotStanding[] {
  return Object.entries(bots).map(([name, bot]) => {
    const mine = (login = "") => loginOf(login) === loginOf(bot.login);
    const said = [...view.reviews, ...view.comments]
      .filter(({ author }) => mine(author?.login))
      .map(({ body }) => body);
    // Greptile writes its summary, verdict included, into the PR body rather than a comment.
    const found = bot.verdict
      ? [...said.toReversed(), view.body]
          .map((text) => new RegExp(bot.verdict!).exec(text)?.[1])
          .find((verdict) => verdict !== undefined)
      : undefined;
    const reviewed = said.length > 0 || found !== undefined;
    const verdictPasses =
      !bot.verdict || (found !== undefined && (!bot.pass || new RegExp(bot.pass).test(found)));
    const passed = reviewed && verdictPasses;
    const open = threads
      .filter(({ author }) => mine(author))
      .map((thread) => `${thread.where}: ${thread.said}`);
    return {
      name,
      reviewed,
      ...(found !== undefined && { verdict: found }),
      passed,
      open,
      settled: passed && (bot.threads === "advisory" || open.length === 0),
    };
  });
}

/** The project's bots' standings on pull request `number`. */
export function botStandings(bots: ReviewBots["bots"], number: number, sh: Exec = exec) {
  const view = ghJson<PrView>(
    ["pr", "view", String(number), "--json", "body,reviews,comments"],
    sh,
  );
  return standings(bots, view, openThreads(number, sh));
}

/** One line a bot: its name, where it stands, its verdict and its open threads. */
export function describe({ name, reviewed, verdict, passed, open, settled }: BotStanding) {
  const where = !reviewed ? "pending" : settled ? "settled" : passed ? "threads open" : "failed";
  return [name, where, verdict ?? "-", open.length > 0 ? open.join("; ") : "-"].join("\t");
}
