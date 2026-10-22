import type { MachineConfig } from "../runtime/machine.ts";
import { type Order, ORDERS } from "../steps/claim/v1/free.ts";

const MODES = ["supervised", "unsupervised", "lights-out"] as const;
export type Mode = (typeof MODES)[number];

/** A named shift: which tickets, how watched, in what order, and when it ends. */
export type Preset = {
  name: string;
  mode?: Mode;
  /** The one project it runs on; every project served when unset. */
  project?: string;
  departments: string[];
  kinds: string[];
  order: Order;
  merged?: number;
  minutes?: number;
  inFlight?: number;
};

export type Slot = { lunch: number } | { preset: Preset };

/** The preset a machine with no rota works: every ticket, in priority order. */
export const DEFAULT_PRESET = "default";

const count = (value: string) => (/^[1-9]\d*$/.test(value) ? Number(value) : undefined);

/** A preset's words: `[mode] [project:<p>] [department:<d>]... [kind:<k>]... [order:<o>] [merged:<n>] [minutes:<n>] [in-flight:<n>]`. */
export function parsePreset(name: string, text: string): Preset | string {
  const preset: Preset = { name, departments: [], kinds: [], order: "priority" };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const [key, value = ""] = word.split(/:(.*)/s);
    if (MODES.includes(word as Mode)) preset.mode = word as Mode;
    else if (key === "project" && value) preset.project = value;
    else if (key === "department" && value) preset.departments.push(value);
    else if (key === "kind" && value) preset.kinds.push(value);
    else if (key === "order" && ORDERS.includes(value as Order)) preset.order = value as Order;
    else if (key === "merged" && count(value)) preset.merged = count(value);
    else if (key === "minutes" && count(value)) preset.minutes = count(value);
    else if (key === "in-flight" && count(value)) preset.inFlight = count(value);
    else return `shift ${name}: can't read "${word}"`;
  }
  return preset;
}

/** The machine config key that holds a preset: `SHIFT_<NAME>`, dashes as underscores. */
export const presetKey = (name: string) => `SHIFT_${name.toUpperCase().replace(/-/g, "_")}`;

/** The named preset from the machine config; `default` is every ticket in priority order unless set. */
export function preset(config: MachineConfig, name: string): Preset | string {
  const text = config[presetKey(name)];
  if (text === undefined)
    return name === DEFAULT_PRESET
      ? parsePreset(name, "")
      : `no shift ${name}: set ${presetKey(name)} in the machine config`;
  return parsePreset(name, text);
}

/** The rota (`ROTA`): preset names and `lunch:<minutes>` breaks, in turn. Unset, one default shift. */
export function rota(config: MachineConfig): Slot[] | string {
  const words = (config.ROTA ?? DEFAULT_PRESET).split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return "ROTA is empty";
  const slots: Slot[] = [];
  for (const word of words) {
    const lunch = /^lunch:(.*)$/.exec(word);
    if (lunch) {
      const minutes = count(lunch[1]!);
      if (!minutes) return `ROTA: ${word} needs its minutes, as lunch:60`;
      slots.push({ lunch: minutes });
      continue;
    }
    const found = preset(config, word);
    if (typeof found === "string") return found;
    slots.push({ preset: found });
  }
  return slots;
}

/** The foreman's invocation arguments for a preset, in the given mode. */
export function foremanArgs(preset: Preset, mode: Mode): string {
  return [
    mode,
    ...preset.departments.map((d) => `department:${d}`),
    ...preset.kinds.map((k) => `kind:${k}`),
    `order:${preset.order}`,
    ...(preset.merged ? [`merged:${preset.merged}`] : []),
    ...(preset.minutes ? [`minutes:${preset.minutes}`] : []),
    ...(preset.inFlight ? [`in-flight:${preset.inFlight}`] : []),
  ].join(" ");
}

/** `factory free`'s arguments for the tickets a preset admits. */
export const freeArgs = (preset: Preset) => [
  ...preset.departments.flatMap((d) => ["--department", d]),
  ...preset.kinds.flatMap((k) => ["--kind", k]),
  "--order",
  preset.order,
];

/** Where the machine is in its rota: the slot, and the projects that slot has already had a shift on. */
export type Position = { at: number; done: string[] };

export type Turn =
  | { take: "shift"; preset: Preset; project: string; next: Position }
  | { take: "lunch"; minutes: number; next: Position }
  | { take: "nothing" };

/** The next turn: a shift is worked once on each project with work for it, an empty one skipped, a lunch break taken. */
export function nextTurn(
  slots: readonly Slot[],
  projects: readonly string[],
  position: Position,
  hasWork: (preset: Preset, project: string) => boolean,
): Turn {
  let at = position.at >= 0 && position.at < slots.length ? position.at : 0;
  let done = at === position.at ? position.done : [];
  for (let walked = 0; walked <= slots.length; walked++) {
    const slot = slots[at]!;
    const after = { at: (at + 1) % slots.length, done: [] };
    if ("lunch" in slot) return { take: "lunch", minutes: slot.lunch, next: after };
    const { preset } = slot;
    const project = projects.find(
      (p) => !done.includes(p) && (!preset.project || preset.project === p) && hasWork(preset, p),
    );
    if (project) return { take: "shift", preset, project, next: { at, done: [...done, project] } };
    ({ at, done } = after);
  }
  return { take: "nothing" };
}
