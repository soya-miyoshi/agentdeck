// The bytes, stated exactly. Every assertion here is a hex code rather than a name, because a name
// is what let this go wrong elsewhere: "Enter" is LF in a text field and CR at a pty.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { keyBytes, withCtrl } from "./key-row.ts";

void describe("the key row's bytes", () => {
  void test("the keys a soft keyboard does not have send what a pty expects", () => {
    assert.equal(keyBytes("esc", false), "\u001b");
    assert.equal(keyBytes("tab", false), "\t");
    // CR, not LF. The pty's line discipline is what turns this into the line a `read` returns; LF
    // at a prompt waiting for a keypress is a blank answer.
    assert.equal(keyBytes("enter", false), "\r");
  });

  void test("the arrows take the form the terminal's cursor-key mode is in", () => {
    assert.equal(keyBytes("up", false), "\u001b[A");
    assert.equal(keyBytes("down", false), "\u001b[B");
    assert.equal(keyBytes("right", false), "\u001b[C");
    assert.equal(keyBytes("left", false), "\u001b[D");
    // DECCKM set: SS3 rather than CSI, which is what a full-screen TUI - an agent's permission
    // prompt among them - asks for when it enables application cursor keys.
    assert.equal(keyBytes("up", true), "\u001bOA");
    assert.equal(keyBytes("down", true), "\u001bOB");
    assert.equal(keyBytes("right", true), "\u001bOC");
    assert.equal(keyBytes("left", true), "\u001bOD");
  });

  void test("Ctrl is a modifier and sends nothing on its own", () => {
    assert.equal(keyBytes("ctrl", false), "");
  });

  void test("a spent Ctrl latch makes the control code", () => {
    // The one a person needs most.
    assert.equal(withCtrl("c"), "\u0003");
    assert.equal(withCtrl("C"), "\u0003");
    assert.equal(withCtrl("d"), "\u0004");
    assert.equal(withCtrl("z"), "\u001a");
    assert.equal(withCtrl("["), "\u001b");
    assert.equal(withCtrl(" "), "\u0000");
    assert.equal(withCtrl("?"), "\u007f");
  });

  void test("a latch spent on a key with no control form sends the key", () => {
    // Visible rather than swallowed: a keystroke that vanishes is indistinguishable from a pty
    // that ignored it.
    assert.equal(withCtrl("1"), "1");
    assert.equal(withCtrl("paste"), "paste");
  });
});
