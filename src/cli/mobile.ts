import { loadProject } from "../config/load.ts";
import { notDeviceMachine, nativeChanges } from "../modules/mobile.ts";
import { exec } from "../runtime/exec.ts";
import { repoName } from "../runtime/github.ts";
import { machineConfig } from "../runtime/machine.ts";

const USAGE = "usage: factory mobile device | native <base> [<head>]";

export async function mobile([what, base, head = "HEAD"]: string[]): Promise<number> {
  const resolved = await loadProject();
  if (what === "device") {
    const why = notDeviceMachine(resolved, machineConfig(repoName().split("/")[1]!));
    console.log(why ?? "this machine runs the project's device checks");
    return why ? 1 : 0;
  }
  if (what !== "native" || !base) {
    console.error(USAGE);
    return 1;
  }
  if (resolved.modules.mobile === "none") {
    console.error("the mobile module is none in factory.config.ts");
    return 1;
  }
  const changes = nativeChanges(resolved.modules.mobile, base, head, exec);
  if (!changes) {
    console.error(`git can't read ${base}...${head}`);
    return 1;
  }
  for (const change of changes) console.log(change);
  return 0;
}
