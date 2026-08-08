// The keys a phone's soft keyboard does not have, as the bytes a pty expects.
//
// This is a byte problem, not a DOM key-event problem. Nothing here dispatches a KeyboardEvent at
// xterm: what travels is exactly what a hardware terminal would put on the wire, and it goes
// through `Connection.input` like every other keystroke.
//
// Why the row exists at all: an agent's permission prompt is answered with Esc, Tab, the arrows,
// Enter or Ctrl+C, and an iOS soft keyboard offers none of them. Without this row the deck is a
// read-only window onto a process that is waiting for an answer.

/** A key cap on the row. Text labels, never a glyph a font may not have. */
export type KeyName = "esc" | "tab" | "up" | "down" | "left" | "right" | "enter" | "ctrl";

/**
 * The arrow keys are the only ones whose bytes depend on the terminal's state.
 *
 * DECCKM - application cursor keys, `ESC [ ? 1 h` - swaps the CSI introducer for SS3, so an arrow
 * is `ESC [ A` normally and `ESC O A` once an application has set it. Full-screen TUIs, which is
 * what an agent's prompt is drawn by, set it routinely. Hardcoding either form sends the other
 * application a sequence it will render as text or ignore.
 *
 * xterm.js exposes the mode it is currently in as `Terminal.modes.applicationCursorKeysMode`, so
 * the form is read off the terminal that is painting the pane rather than guessed at.
 */
const arrow = (final: string, applicationCursorKeys: boolean): string =>
  `\u001b${applicationCursorKeys ? "O" : "["}${final}`;

/**
 * The bytes a key sends.
 *
 * Enter is CR (0x0d), not LF: a pty in canonical mode is what turns CR into the line the process
 * reads, and sending LF gets a blank line at a prompt that is waiting for a keypress.
 */
export const keyBytes = (key: KeyName, applicationCursorKeys: boolean): string => {
  switch (key) {
    case "esc":
      return "\u001b";
    case "tab":
      return "\t";
    case "enter":
      return "\r";
    case "up":
      return arrow("A", applicationCursorKeys);
    case "down":
      return arrow("B", applicationCursorKeys);
    case "left":
      return arrow("D", applicationCursorKeys);
    case "right":
      return arrow("C", applicationCursorKeys);
    case "ctrl":
      // Not a key. See `withCtrl`.
      return "";
  }
};

/**
 * Ctrl applied to what was typed next.
 *
 * Ctrl is a MODIFIER, and a touch screen has no way to hold one down while pressing another cap -
 * there is one thumb and the second press is a separate event. So the cap LATCHES: press Ctrl,
 * press the next thing, and the latch is spent. That is the same bargain a phone's own Shift key
 * makes, so it needs no explaining to the person holding it, and it is the only shape that makes
 * Ctrl+C - the one a person needs most, and 0x03 - reachable at all.
 *
 * The control code is the ASCII rule rather than a table: bytes 0x40-0x5f with bit 6 cleared, which
 * is what a real keyboard's controller does, plus the two a keyboard also sends and the rule does
 * not reach: Ctrl+Space is NUL and Ctrl+? is DEL. Anything else is passed through unchanged - a
 * latch spent on a key that has no control form sends the key, which is a visible result rather
 * than a swallowed keystroke.
 */
export const withCtrl = (data: string): string => {
  if (data.length !== 1) return data;
  const upper = data.toUpperCase();
  const code = upper.codePointAt(0) ?? 0;
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  if (data === " ") return "\u0000";
  if (data === "?") return "\u007f";
  return data;
};
