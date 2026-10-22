import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { exec } from "../runtime/exec.ts";
import { who } from "../runtime/github.ts";
import { FACTORY_HOME } from "../runtime/machine.ts";
import { runJob } from "../runner/child.ts";
import { type Control, handShift, off, on, plist, stop } from "../runner/control.ts";
import { status } from "../runner/status.ts";
import { tick } from "../runner/tick.ts";

const USAGE =
  "usage: factory runner tick [--dry-run] | status [--watch [<seconds>]] | on | off | stop | plist | shift <project> [<preset> | <foreman args>...]";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const control = (): Control => ({
  home: FACTORY_HOME,
  user: homedir(),
  sh: exec,
  uid: process.getuid?.() ?? 0,
  print: (line) => console.log(line),
});

const screen = () =>
  status({ home: FACTORY_HOME, user: homedir(), sh: exec, now: Date.now(), alive }).join("\n");

/** `factory runner <command>`: the one runner on this machine, which works the rota across every project it serves. */
export async function runner([command, ...args]: string[]): Promise<number> {
  switch (command) {
    case "tick": {
      if (args.length > 1 || (args[0] !== undefined && args[0] !== "--dry-run")) break;
      let person: string | undefined;
      return tick({
        home: FACTORY_HOME,
        sh: exec,
        run: (job) => runJob(job),
        now: Date.now,
        dry: args[0] === "--dry-run",
        print: (line) => console.log(line),
        pid: process.pid,
        alive,
        who: () => (person ??= who(exec)),
        turnOff: () => off(control()),
      });
    }
    case "status": {
      if (args.length === 0) {
        console.log(screen());
        return 0;
      }
      const every = Number(args[1] ?? 30);
      if (args[0] !== "--watch" || args.length > 2 || !(every > 0)) break;
      for (;;) {
        const out = screen();
        console.clear();
        console.log(`${out}\n\n(every ${every}s, ctrl-c to stop)`);
        await new Promise((resolve) => setTimeout(resolve, every * 1000));
      }
    }
    case "on":
    case "off":
    case "stop":
      if (args.length > 0) break;
      return { on, off, stop }[command](control());
    case "plist":
      if (args.length > 0) break;
      console.log(
        plist({
          node: process.execPath,
          cli: realpathSync(process.argv[1]!),
          home: FACTORY_HOME,
          user: homedir(),
        }).trimEnd(),
      );
      return 0;
    case "shift":
      return handShift(
        {
          ...control(),
          tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          attach: (tmux, env) => spawnSync("tmux", tmux, { stdio: "inherit", env }).status ?? 1,
        },
        args,
      );
  }
  console.log(USAGE);
  return 2;
}
