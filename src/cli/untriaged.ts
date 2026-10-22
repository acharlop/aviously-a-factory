import { exec, type Exec } from "../runtime/exec.ts";
import { ghJson } from "../runtime/github.ts";
import { type Listed, untriaged as notRouted } from "../steps/triage/v1/step.ts";

/** `factory untriaged`: one `<number>\t<title>` line per ticket the receptionist has yet to route. */
export async function untriaged(_args: string[], sh: Exec = exec): Promise<number> {
  const issues = ghJson<Listed[]>(
    ["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,labels"],
    sh,
  );
  for (const { number, title } of notRouted(issues)) console.log(`${number}\t${title}`);
  return 0;
}
