import assert from "node:assert/strict";
import { test } from "node:test";

import { name } from "./index.ts";

void test("the placeholder module loads", () => {
  assert.equal(name, "agentdeck");
});
