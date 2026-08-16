// The keys a soft keyboard does not have, as the bytes a pty expects - a byte problem rather than a
// DOM one. An agent's permission prompt is answered with exactly the keys iOS does not offer.

/** A key cap on the row. Text labels, never a glyph a font may not have. */
export type KeyName = "esc" | "tab" | "up" | "down" | "left" | "right" | "enter" | "ctrl";

/**
 * The arrows are the only keys whose bytes depend on terminal state: DECCKM swaps CSI for SS3, and
 * a TUI sets it routinely. Read off xterm's own mode rather than guessed at.
 */
const arrow = (final: string, applicationCursorKeys: boolean): string =>
  `\u001b${applicationCursorKeys ? "O" : "["}${final}`;

/**
 * The bytes a key sends. Enter is CR (0x0d) and not LF: the pty's line discipline is what turns CR
 * into a line, and LF gets a blank line at a prompt waiting for a keypress.
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
 * Ctrl applied to what was typed next. One thumb cannot hold a modifier, so the cap LATCHES, the
 * same bargain Shift makes. The code is the ASCII rule, plus the two a keyboard sends that it misses.
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

/**
 * Whether what is being sent may spend an armed Ctrl latch. xterm raises `onData` for the
 * terminal's own multi-byte replies too, and a latch spent on one loses the interrupt silently.
 */
export const spendable = (data: string): boolean => [...data].length === 1 && data !== "\u001b";
