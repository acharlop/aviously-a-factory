import assert from "node:assert/strict";
import { test } from "node:test";

import { FACTORY_LABELS } from "../../../labels.ts";
import { pluginFile, tableUnder } from "../../../plugin-files.fixture.ts";
import { type Listed, ROUTES, triage1, untriaged } from "./step.ts";

const LABELS = FACTORY_LABELS.map(({ name }) => name);
const KINDS = LABELS.filter((name) => name.startsWith("kind:"));

const listed = (number: number, ...names: string[]): Listed => ({
  number,
  title: `Ticket ${number}`,
  labels: names.map((name) => ({ name })),
});

test("untriaged is an open ticket with no route, never an epic or odd jobs, oldest first", () => {
  const issues = [
    listed(3, "kind:bug"),
    ...ROUTES.map((route, i) => listed(10 + i, route, "kind:bug")),
    listed(20, "epic"),
    listed(21, "odd jobs", "kind:debt"),
    listed(1),
  ];
  assert.deepEqual(
    untriaged(issues).map(({ number }) => number),
    [1, 3],
  );
});

test("routes, epics and odd jobs are factory labels", () => {
  for (const name of [...ROUTES, "epic", "odd jobs"]) assert.ok(LABELS.includes(name), name);
});

const agent = `agents/${triage1.agent}.md`;

test("the receptionist gives every route, kind and recall", () => {
  const text = pluginFile(agent);
  for (const label of [...ROUTES, ...KINDS, "recall"])
    assert.ok(text.includes(`\`${label}\``), label);
  assert.match(text, /pnpm factory untriaged/);
  assert.match(text, /department:<name>/);
});

test("the receptionist and the meeting route by the same table", () => {
  const routes = tableUnder(agent, "Routes");
  assert.ok(routes && routes.length === ROUTES.length + 2);
  assert.deepEqual(tableUnder("skills/meeting/SKILL.md", "Routes"), routes);
  ROUTES.forEach((route, i) => assert.ok(routes[i + 2]!.startsWith(`| \`${route}\``), route));
});
