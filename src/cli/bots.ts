import { loadProject } from "../config/load.ts";
import { botStandings, describe } from "../modules/review-bots.ts";
import { exec, type Exec } from "../runtime/exec.ts";

/** `factory bots <pr>`: each review bot's standing on the pull request, one a line; exits 0 once every one is settled. */
export async function bots(args: string[], sh: Exec = exec): Promise<number> {
  const number = Number(args[0]);
  if (args.length !== 1 || !Number.isInteger(number) || number <= 0) {
    console.log("usage: factory bots <pr>");
    return 2;
  }
  const { reviewBots } = (await loadProject()).modules;
  if (reviewBots === "none") {
    console.log("the reviewBots module is none in factory.config.ts");
    return 0;
  }
  const standings = botStandings(reviewBots.bots, number, sh);
  for (const standing of standings) console.log(describe(standing));
  return standings.every(({ settled }) => settled) ? 0 : 1;
}
