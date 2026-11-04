import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { historyBytes } from "./repaint.ts";

void describe("a snapshot's history goes into scrollback before the screen is drawn", () => {
  void test("exactly one screen of newlines follows it, whatever row it ended on", () => {
    // Fewer, and the last rows of history are still on screen when the repaint draws over them -
    // which is how a reconnect lost the screenful of output just before the live one.
    assert.equal(historyBytes("a\r\nb", 3), "a\r\nb\r\n\r\n\r\n");
  });

  void test("no history writes nothing, so a fresh session gets no blank lines above it", () => {
    assert.equal(historyBytes("", 30), "");
  });

  void test("the page writes history through it, not raw", () => {
    const app = readFileSync(new URL("App.vue", import.meta.url), "utf8");
    assert.match(app, /historyBytes\(action\.history/);
    assert.doesNotMatch(app, /handle\.write\(action\.history\)/);
  });
});
