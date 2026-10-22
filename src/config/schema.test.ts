import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CONFIG_VERSION, jsonSchema } from "./schema.ts";

test(`schema/v${CONFIG_VERSION}.json matches the Zod schema (regenerate: pnpm factory schema > schema/v${CONFIG_VERSION}.json)`, () => {
  const committed = readFileSync(
    new URL(`../../schema/v${CONFIG_VERSION}.json`, import.meta.url),
    "utf8",
  );
  assert.deepEqual(JSON.parse(committed), jsonSchema());
});
