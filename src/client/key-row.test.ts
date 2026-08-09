// The bytes, stated exactly. Every assertion here is a hex code rather than a name, because a name
// is what let this go wrong elsewhere: "Enter" is LF in a text field and CR at a pty.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { type KeyName, keyBytes, spendable, withCtrl } from "./key-row.ts";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

void describe("the key row's bytes", () => {
  void test("the keys a soft keyboard does not have send what a pty expects", () => {
    assert.equal(keyBytes("esc", false), "\u001b");
    assert.equal(keyBytes("tab", false), "\t");
    // CR, not LF. The pty's line discipline is what turns this into the line a `read` returns; LF
    // at a prompt waiting for a keypress is a blank answer.
    assert.equal(keyBytes("enter", false), "\r");
    // Stated as codes as well as escapes, because "\t" and "\r" are the two a careless edit turns
    // into "\n" without changing how the line reads.
    assert.equal(keyBytes("esc", false).codePointAt(0), 0x1b);
    assert.equal(keyBytes("tab", false).codePointAt(0), 0x09);
    assert.equal(keyBytes("enter", false).codePointAt(0), 0x0d);
    // Esc, Tab and Enter are what they are whatever the terminal's cursor-key mode is: DECCKM
    // governs the arrows and nothing else.
    for (const key of ["esc", "tab", "enter"] as const) {
      assert.equal(keyBytes(key, true), keyBytes(key, false), `${key} changed with DECCKM`);
    }
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
    // The two forms are never the same string, which is the whole reason the mode has to be asked
    // for rather than assumed - a row that ignored it would be wrong for half the applications and
    // right for the other half, and both look like "the arrow key did nothing".
    for (const key of ["up", "down", "left", "right"] as const) {
      assert.notEqual(keyBytes(key, true), keyBytes(key, false));
      // Same final byte in both forms, only the introducer moves.
      assert.equal(keyBytes(key, true).slice(2), keyBytes(key, false).slice(2));
    }
  });

  void test("Ctrl is a modifier and sends nothing on its own", () => {
    assert.equal(keyBytes("ctrl", false), "");
    assert.equal(keyBytes("ctrl", true), "");
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

  void test("the control code is the ASCII rule, at both ends of the range", () => {
    // Bit 6 cleared over 0x40-0x5f rather than a hand-written table, which is where `@` and `_`
    // go missing: `@` is NUL and `_` is 0x1f.
    assert.equal(withCtrl("@"), "\u0000");
    assert.equal(withCtrl("_"), "\u001f");
    assert.equal(withCtrl("a"), "\u0001");
    // Case-folded, because the soft keyboard sends whichever case Shift happened to be in and a
    // person pressing Ctrl is not thinking about that.
    for (let code = 0x41; code <= 0x5a; code++) {
      const upper = String.fromCharCode(code);
      assert.equal(withCtrl(upper), String.fromCharCode(code & 0x1f), `Ctrl and ${upper}`);
      assert.equal(withCtrl(upper.toLowerCase()), withCtrl(upper), `case matters for ${upper}`);
    }
  });

  void test("a latch spent on a key with no control form sends the key", () => {
    // Visible rather than swallowed: a keystroke that vanishes is indistinguishable from a pty
    // that ignored it.
    assert.equal(withCtrl("1"), "1");
    assert.equal(withCtrl("paste"), "paste");
    // A cap's own sequence is more than one character, so a latch left on and then spent on an
    // arrow sends the arrow rather than a mangled introducer.
    assert.equal(withCtrl(keyBytes("up", false)), keyBytes("up", false));
    assert.equal(withCtrl(keyBytes("up", true)), keyBytes("up", true));
    // Esc is one character and outside 0x40-0x5f, so it survives a latch as itself.
    assert.equal(withCtrl(keyBytes("esc", false)), "\u001b");
    // Nothing is still nothing: Ctrl sends the empty string, and a latch must not turn that into
    // a byte the pty would act on.
    assert.equal(withCtrl(keyBytes("ctrl", false)), "");
  });
});

// The row and the page are Vue single-file components, and what they do to a terminal is proven in
// end-to-end.test.ts, where App.vue's key handling is restated over a real pty. What is checked
// here is the wiring that restatement cannot see: that a cap exists for every key, that the caps
// are text, that the page reads the terminal's cursor-key mode instead of choosing one, and that
// the row's bytes go through `Connection.input` rather than around it. Each of those is a way for
// the bytes above to be exactly right and the phone still to have no way of sending them.
//
// Source text rather than a mounted component: mounting needs a DOM, and a DOM is a dependency,
// and the budget is spent. What is asserted is therefore shape, and it is paired with the
// behavioural tests over the real pty rather than offered in place of them.

void describe("the row as it is wired into the page", () => {
  const keyRow = source("KeyRow.vue");
  const app = source("App.vue");
  const pane = source("TerminalPane.vue");
  const handle = source("terminal-handle.ts");

  /** The key names the module declares, read off the union rather than restated here. */
  const declaredKeys = (): KeyName[] => {
    const union = /export type KeyName =([^;]+);/.exec(source("key-row.ts"))?.[1];
    assert.ok(union !== undefined, "key-row.ts declares no KeyName union");
    return [...union.matchAll(/"([a-z]+)"/g)].map(([, name]) => name as KeyName);
  };

  void test("every key the module can send has a cap to send it from", () => {
    const keys = declaredKeys();
    assert.deepEqual(
      [...keys].sort((a, b) => a.localeCompare(b)),
      ["ctrl", "down", "enter", "esc", "left", "right", "tab", "up"],
      "the row's key set changed: Esc, Tab, the arrows, Enter and Ctrl are the done-when",
    );
    for (const key of keys) {
      assert.match(
        keyRow,
        new RegExp(`["']${key}["']`),
        `KeyRow.vue has no cap for ${key}, so a phone cannot send it at all`,
      );
    }
  });

  void test("the caps are text labels, never a glyph", () => {
    // The repository rule, on the one surface where the instinct is a picture. An arrow drawn as a
    // character is a different height in every font on every phone and several are simply absent
    // from what iOS falls back to, which leaves a blank cap on the row that answers the prompt.
    assert.doesNotMatch(keyRow, /\p{Extended_Pictographic}/u, "an emoji on a key cap");
    // Arrows, triangles, and the return symbol, by code point so this file contains none of them.
    const glyphs = /[←-⇿▲▼◀▶⏎↵⬀-⯿]/u;
    assert.doesNotMatch(keyRow, glyphs, "an arrow or return glyph on a key cap");
    for (const label of ["Esc", "Tab", "Left", "Down", "Up", "Right", "Enter", "Ctrl"]) {
      assert.ok(
        new RegExp(`>\\s*${label}\\s*<`).test(keyRow) || keyRow.includes(`"${label}"`),
        `no text label for ${label}`,
      );
    }
  });

  void test("the caps claim the touch target and the row carries the bottom inset", () => {
    // m4/pwa's two phone properties, at the source. `src/pwa.test.ts` holds the same two against
    // the built CSS; this says which element they belong to, which is what the built CSS cannot.
    assert.match(keyRow, /min-height:\s*var\(--touch-target\)/);
    // Width is NOT the touch target and must not become it again: eight caps at 44px need 388px
    // plus gaps, more than a phone has, and the row scrolled Ctrl off the right-hand edge. The
    // caps shrink to share whatever width there is. Reported from a real device: Ctrl cut off.
    assert.doesNotMatch(keyRow, /min-width:\s*var\(--touch-target\)/);
    assert.match(keyRow, /flex:\s*1\s+1\s+0/, "the caps do not shrink to fit the row");
    assert.match(keyRow, /padding:[^;]*var\(--safe-bottom\)/);
    // The row owns the bottom edge now, so the pane area must NOT inset the bottom as well: that
    // leaves a band of pane background between the caps and the home indicator, and it is the
    // exact regression a later "put the inset back where it was" makes.
    const panes = /\.panes\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    assert.notEqual(panes, "", "App.vue has no .panes rule");
    assert.doesNotMatch(panes, /--safe-bottom/, "the pane area insets the bottom edge as well");
    // And the row is below the panes in the column, not floating over the last terminal rows -
    // which is where a permission prompt and the cursor are.
    assert.ok(
      app.indexOf("<KeyRow") > app.indexOf('<main class="panes">'),
      "the key row is not below the terminal",
    );
  });

  void test("a cap does not steal focus from the terminal, and still fires on a phone", () => {
    // This asserted `@mousedown.prevent` and `@touchstart.prevent`, which is the mechanism that
    // BROKE it: preventing a touch event suppresses the synthetic click iOS would have sent, so
    // the `@click` behind it never ran and every cap was dead on a real device. It asserts the two
    // properties now - focus is kept, and the emit happens on an event that actually fires -
    // rather than the spelling that was supposed to deliver them.
    assert.match(keyRow, /\.prevent/, "the soft keyboard will close under the thumb");
    assert.doesNotMatch(
      keyRow,
      /@click=/,
      "a cap emits on click; with the pointer event prevented that never fires on iOS",
    );
    assert.match(keyRow, /@pointerdown\.prevent="\$emit/, "no cap emits on pointerdown");
  });

  void test("the arrows' form is read off the terminal, not chosen by the page", () => {
    // The DECCKM half of the done-when. A page that passed a literal here would be right for
    // whichever half of the applications it guessed at and wrong for the other, and both failures
    // look identical from the phone: the arrow key did nothing.
    assert.match(app, /keyBytes\(\s*key\s*,[^;]*applicationCursorKeys\(\)/);
    assert.doesNotMatch(app, /keyBytes\([^;]*,\s*(true|false)\s*\)\s*;/);
    // The handle's answer is xterm's own mode, tracked as the application sets and clears it,
    // rather than anything this project parses out of the stream itself.
    assert.match(
      pane,
      /applicationCursorKeys:\s*\(\)\s*=>\s*term\.modes\.applicationCursorKeysMode/,
    );
    assert.match(handle, /applicationCursorKeys:\s*\(\)\s*=>\s*boolean/);
  });

  void test("Ctrl latches, shows that it is latched, and is spent by the next thing sent", () => {
    // A modifier a thumb cannot hold down. Pressing it a second time must clear it: a latch with
    // no way off is a terminal that answers every following keystroke with a control code.
    assert.match(app, /ctrlLatched\.value = !ctrlLatched\.value/);
    // Spent by whatever goes out next - a cap, or a character from the soft keyboard - which is
    // the only shape in which Ctrl and then `c` reaches 0x03. Both routes go through one `send`.
    const send = /const send = \(data: string\): void => \{([\s\S]*?)\n\};/.exec(app)?.[1] ?? "";
    assert.notEqual(send, "", "App.vue has no send()");
    assert.match(send, /withCtrl\(data\)/);
    assert.match(send, /ctrlLatched\.value = false/);
    assert.match(app, /const typed = [\s\S]*?send\(data\)/);
    // Visible while it is on. A modifier whose state cannot be seen is one a person cannot
    // recover from, and the recovery here is pressing the same cap again.
    assert.match(keyRow, /:aria-pressed="ctrlLatched"/);
    assert.match(keyRow, /:class="\{ latched: ctrlLatched \}"/);
    assert.match(keyRow, /\.cap\.latched\s*\{/);
  });

  void test("the terminal's own replies do not spend the latch", () => {
    // xterm raises `onData` for what the TERMINAL owes the application as well as for keystrokes:
    // the DSR/DA/DECRQM answers a TUI in the pane asks for. Those reach `send` by the same route a
    // typed character does, and a `send` that cleared the latch unconditionally let an agent's own
    // output disarm Ctrl - so the operator's following `c` arrived as the letter `c` and no SIGINT
    // was sent, silently, with the cap un-highlighted as if the interrupt had been delivered.
    const send = /const send = \(data: string\): void => \{([\s\S]*?)\n\};/.exec(app)?.[1] ?? "";
    assert.notEqual(send, "", "App.vue has no send()");
    assert.doesNotMatch(
      send,
      /^\s*ctrlLatched\.value = false;\s*$/m,
      "send() clears the latch unconditionally, so a terminal reply spends it",
    );
    // The rule itself, imported from the module rather than read out of the page's source text and
    // executed: running repository text in the test process makes whatever that text says a thing
    // the host runs at every `pnpm test`, and App.vue is not a file the host is meant to execute.
    // What the operator meant: Ctrl and then `c`.
    assert.equal(spendable("c"), true);
    // What the agent's TUI writes back through the same emit. A cursor-position report, the two
    // device-attribute answers, and a mode report - none may disarm the one control the phone has.
    for (const reply of ["\u001b[24;1R", "\u001b[?1;2c", "\u001b[>0;10;1c", "\u001b[?2004;2$y"]) {
      assert.equal(spendable(reply), false, `a terminal reply spent the latch: ${reply}`);
    }
    // A cap's own sequence is not a character either, so an arrow pressed with Ctrl on leaves the
    // latch armed rather than throwing it away on a byte `withCtrl` cannot modify.
    assert.equal(spendable(keyBytes("up", false)), false);
    assert.equal(spendable(keyBytes("up", true)), false);
    assert.equal(spendable(keyBytes("esc", false)), false);
    // The wiring the behavioural assertions above cannot see: the page asks this module rather
    // than keeping a second copy of the rule that can be loosened on its own.
    assert.match(app, /from "\.\/key-row\.ts";/);
    assert.match(
      app,
      /\bspendable\b[^\n]*from "\.\/key-row\.ts"|import \{[\s\S]*?spendable[\s\S]*?\} from "\.\/key-row\.ts"/,
    );
    assert.match(send, /spendable\(data\)/);
    assert.doesNotMatch(app, /const spendable = /, "App.vue keeps its own copy of the rule");
    // And no test may execute text it read out of the repository: that is a second, unenumerated
    // way for a file nobody reviews as host-executed to run with the human's privileges.
    const self = source("key-row.test.ts");
    assert.doesNotMatch(self, /data:text\/javascript/, "this test executes repository source text");
  });

  void test("the row is not a side channel: its bytes go through Connection.input", () => {
    // `Connection.input` chunks and paces, because `ws` enforces its 64 KiB frame limit before the
    // message event ever fires (see end-to-end.test.ts). A row that wrote to a socket itself would
    // be a second, unpaced path to the same pty, and it would be discovered as a tab that goes
    // blank when somebody pastes.
    const send = /const send = \(data: string\): void => \{([\s\S]*?)\n\};/.exec(app)?.[1] ?? "";
    assert.match(send, /connection\.value\?\.input\(/);
    // The component knows nothing about transports at all: it emits a key name, and the page turns
    // that into bytes. No component below the page invents a byte.
    assert.doesNotMatch(keyRow, /connection|socket|WebSocket|fetch\(/i);
    assert.match(keyRow, /defineEmits<\{ key: \[key: KeyName\] \}>/);
  });
});
