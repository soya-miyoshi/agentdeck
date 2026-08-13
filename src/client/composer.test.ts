// The bytes a submit puts on the wire, stated as codes rather than names - "send" is CR at a pty
// and LF in a text field, and the box this comes from is a text field.
//
// The parts that cannot be executed without a browser - that the pane takes no keystrokes, and that
// the box sits where a thumb can reach it - are asserted against the components' source, the same
// way key-row.test.ts asserts the row's layout.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { spendsCtrl, submitBytes } from "./composer.ts";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const app = source("App.vue");
const pane = source("TerminalPane.vue");
const composer = source("Composer.vue");

void describe("the composer's bytes", () => {
  void test("send submits the line and insert does not", () => {
    assert.equal(submitBytes("ls", "send", false), "ls\r");
    assert.equal(submitBytes("ls", "insert", false), "ls");
    // CR, not LF: LF at an agent's prompt is a blank line rather than the answer.
    assert.equal(submitBytes("ls", "send", false).codePointAt(2), 0x0d);
  });

  void test("an empty box sends nothing at all", () => {
    // Enter with an empty box is the key row's Enter cap, not this. A Send that fires a bare CR
    // answers whatever prompt happens to be up, which is the accident this refuses.
    assert.equal(submitBytes("", "send", false), "");
    assert.equal(submitBytes("", "insert", false), "");
    assert.equal(submitBytes("", "send", true), "");
    assert.equal(spendsCtrl(""), false);
    assert.equal(spendsCtrl("c"), true);
  });

  void test("newlines inside the text stay LF, so a paste is one turn and not five", () => {
    const pasted = "first\nsecond\nthird";
    assert.equal(submitBytes(pasted, "send", false), "first\nsecond\nthird\r");
    // The property, not the spelling: exactly one CR, at the end, whatever the text contains.
    const sent = submitBytes(pasted, "send", false);
    assert.equal([...sent].filter((character) => character === "\r").length, 1);
    assert.ok(sent.endsWith("\r"));
    // An agent's TUI reads CR as "submit this prompt", so converting the embedded newlines would
    // send a three-line question as three separate turns - the first one two thirds of a sentence.
    assert.doesNotMatch(sent.slice(0, -1), /\r/);
  });

  void test("a latched Ctrl makes the first character a control code and appends no CR", () => {
    // The one a person needs most, and the only way to reach it now that no path sends single
    // characters from the soft keyboard: press Ctrl, type `c`, press Send.
    assert.equal(submitBytes("c", "send", true), "\u0003");
    assert.equal(submitBytes("c", "send", true).codePointAt(0), 0x03);
    assert.equal(submitBytes("C", "send", true), "\u0003");
    assert.equal(submitBytes("d", "send", true), "\u0004");
    // No CR after it. Ctrl is a modifier on a KEY, not on a line, and the newline would land as a
    // blank answer at whatever prompt the interrupt uncovered.
    assert.doesNotMatch(submitBytes("c", "send", true), /\r/);
    // Insert and send are the same act once Ctrl is latched, because neither is a line any more.
    assert.equal(submitBytes("c", "insert", true), submitBytes("c", "send", true));
    // Whatever follows the first character is still sent, literally. A latch spent on something
    // with no control form is a visible result rather than a swallowed keystroke - withCtrl's rule.
    assert.equal(submitBytes("ca", "send", true), "\u0003a");
  });
});

void describe("where input comes from", () => {
  void test("the pane takes no keystrokes, and still answers the agent's own queries", () => {
    // `disableStdin` is the obvious way to do this and the wrong one: it gates xterm's whole
    // triggerDataEvent, so the terminal's replies - DSR, DA - never reach the pty either, and a TUI
    // that asks where the cursor is waits forever for an answer nobody sent.
    // The option, not the word: the pane's comment names it to say why it is not used.
    assert.doesNotMatch(pane, /disableStdin\s*:/, "the pane's stdin is disabled wholesale");
    assert.match(pane, /textarea\.readOnly\s*=\s*true/, "iOS will open the keyboard over the pane");
    assert.match(pane, /attachCustomKeyEventHandler\(\(\)\s*=>\s*false\)/);
    // The reply path is still wired. Without this the read-only textarea has taken the keystrokes
    // AND the answers, and nothing says so.
    assert.match(pane, /term\.onData\(/, "the terminal's replies no longer reach the wire");
  });

  void test("the box is between the terminal and the key row, and reachable one-handed", () => {
    assert.ok(
      app.indexOf("<Composer") > app.indexOf('<main class="panes">'),
      "the composer is above the terminal",
    );
    assert.ok(app.indexOf("<Composer") < app.indexOf("<KeyRow"), "the composer is below the keys");
    assert.match(composer, /min-height:\s*var\(--touch-target\)/);
    // 16px exactly. Safari zooms the page in when a field under 16px takes focus, and the app is
    // pinned to the visual viewport that zoom then changes - so the deck jumps as you start typing.
    assert.match(composer, /font-size:\s*16px/, "Safari will zoom the page when the box is tapped");
  });

  void test("the buttons keep the keyboard open and still fire on a phone", () => {
    // The same lesson KeyRow.vue was taught by a real device: preventing the pointer event is what
    // keeps focus, and it also suppresses the synthetic click, so a @click handler never runs.
    assert.match(composer, /@pointerdown\.prevent="submit/);
    assert.doesNotMatch(composer, /@click="submit/);
  });
});
