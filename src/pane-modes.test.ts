import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { modeBytes, NO_PANE_MODES, readPaneModes } from "./pane-modes.ts";

const ESC = String.fromCharCode(27);

void describe("reading the pane's modes from tmux", () => {
  void test("an agent on the alternate screen tracking every motion in SGR", () => {
    assert.deepEqual(readPaneModes("10011\n"), { alternate: true, tracking: 1003, sgr: true });
  });

  void test("a shell has set none of them", () => {
    assert.deepEqual(readPaneModes("00000"), NO_PANE_MODES);
  });

  void test("the highest tracking mode wins, since it reports what the lower ones do", () => {
    assert.equal(readPaneModes("01110").tracking, 1003);
    assert.equal(readPaneModes("01100").tracking, 1002);
    assert.equal(readPaneModes("01000").tracking, 1000);
  });

  void test("an answer that is not five digits sets nothing rather than guessing", () => {
    assert.deepEqual(readPaneModes(""), NO_PANE_MODES);
    assert.deepEqual(readPaneModes("Tailscale.CLIError"), NO_PANE_MODES);
    assert.deepEqual(readPaneModes("1001"), NO_PANE_MODES);
  });
});

void describe("restating the modes to a client", () => {
  void test("the alternate screen comes first, so the screen below lands in it", () => {
    assert.equal(
      modeBytes({ alternate: true, tracking: 1003, sgr: true }),
      `${ESC}[?1049h${ESC}[?1003h${ESC}[?1006h`,
    );
  });

  void test("a shell's snapshot carries no modes at all", () => {
    assert.equal(modeBytes(NO_PANE_MODES), "");
  });
});
