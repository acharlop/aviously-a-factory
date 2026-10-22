import assert from "node:assert/strict";
import { test } from "node:test";

import {
  foremanArgs,
  freeArgs,
  nextTurn,
  parsePreset,
  type Preset,
  preset,
  rota,
  type Slot,
} from "./rota.ts";

const named = (name: string, text = "") => parsePreset(name, text) as Preset;

test("a preset is a filter, a mode, an order and an end condition", () => {
  assert.deepEqual(
    parsePreset(
      "web",
      "lights-out department:web kind:feature kind:bug order:fifo merged:3 minutes:90",
    ),
    {
      name: "web",
      mode: "lights-out",
      departments: ["web"],
      kinds: ["feature", "bug"],
      order: "fifo",
      merged: 3,
      minutes: 90,
    },
  );
  assert.match(parsePreset("x", "order:random") as string, /can't read "order:random"/);
  assert.match(parsePreset("x", "merged:0") as string, /can't read "merged:0"/);
});

test("no rota is one unfiltered shift in priority order", () => {
  assert.deepEqual(rota({}), [{ preset: named("default") }]);
  assert.equal(foremanArgs(named("default"), "lights-out"), "lights-out order:priority");
  assert.deepEqual(freeArgs(named("default")), ["--order", "priority"]);
});

test("a rota names presets from SHIFT_<NAME> and lunch breaks in minutes", () => {
  const config = {
    ROTA: "features features debt-pass lunch:60",
    SHIFT_FEATURES: "kind:feature merged:2",
    SHIFT_DEBT_PASS: "kind:debt order:fifo",
  };
  const slots = rota(config) as Slot[];
  assert.equal(slots.length, 4);
  assert.deepEqual(slots[2], { preset: named("debt-pass", "kind:debt order:fifo") });
  assert.deepEqual(slots[3], { lunch: 60 });
  assert.match(rota({ ROTA: "nights" }) as string, /no shift nights: set SHIFT_NIGHTS/);
  assert.match(rota({ ROTA: "lunch" }) as string, /no shift lunch/);
  assert.match(rota({ ROTA: "lunch:soon" }) as string, /needs its minutes/);
  assert.deepEqual(preset({ SHIFT_DEFAULT: "kind:bug" }, "default"), named("default", "kind:bug"));
});

const slots: Slot[] = [
  { preset: named("features", "kind:feature") },
  { preset: named("debt", "kind:debt") },
  { lunch: 30 },
];

test("each shift is worked once on every project with work for it, then the rota moves on", () => {
  const work = () => true;
  const first = nextTurn(slots, ["a", "b"], { at: 0, done: [] }, work);
  assert.deepEqual(first, {
    take: "shift",
    preset: named("features", "kind:feature"),
    project: "a",
    next: { at: 0, done: ["a"] },
  });
  const second = nextTurn(slots, ["a", "b"], { at: 0, done: ["a"] }, work);
  assert.equal(second.take === "shift" && second.project, "b");
  const third = nextTurn(slots, ["a", "b"], { at: 0, done: ["a", "b"] }, work);
  assert.equal(third.take === "shift" && `${third.preset.name} ${third.project}`, "debt a");
});

test("an empty shift is skipped, and a lunch break reached is taken", () => {
  const onlyDebtOnB = (p: Preset, project: string) => p.name === "debt" && project === "b";
  const turn = nextTurn(slots, ["a", "b"], { at: 0, done: [] }, onlyDebtOnB);
  assert.equal(turn.take === "shift" && `${turn.preset.name} ${turn.project}`, "debt b");
  assert.deepEqual(nextTurn(slots, ["a", "b"], { at: 1, done: ["b"] }, onlyDebtOnB), {
    take: "lunch",
    minutes: 30,
    next: { at: 0, done: [] },
  });
});

test("with no work anywhere and no lunch break, nothing is taken", () => {
  const shifts = slots.slice(0, 2);
  assert.deepEqual(
    nextTurn(shifts, ["a"], { at: 1, done: [] }, () => false),
    { take: "nothing" },
  );
});

test("a preset pinned to a project runs only there, and a stale position starts over", () => {
  const pinned: Slot[] = [{ preset: named("b-only", "project:b") }];
  const turn = nextTurn(pinned, ["a", "b"], { at: 7, done: ["a", "b"] }, () => true);
  assert.equal(turn.take === "shift" && turn.project, "b");
});
