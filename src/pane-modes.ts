// The pane's terminal modes, and the escape sequence that restates them. A repaint carries cells
// only, so without this a client rebuilt from a snapshot has the modes of a terminal just opened.

export interface PaneModes {
  /** The alternate screen, where the application owns the transcript and there is no scrollback. */
  alternate: boolean;
  /** Mouse tracking as the application set it: the mode number, or 0 for none. */
  tracking: 0 | 1000 | 1002 | 1003;
  /** SGR (1006) encoding, which is how a modern application asks to be told about the mouse. */
  sgr: boolean;
}

export const NO_PANE_MODES: PaneModes = { alternate: false, tracking: 0, sgr: false };

const ESC = "\x1b";

/**
 * Read the five 0/1 digits of `#{alternate_on}` and the four mouse flags. Anything else - an empty
 * answer, a mangled one - is "no modes set", which is the state a fresh terminal is already in.
 */
export const readPaneModes = (stdout: string): PaneModes => {
  const digits = stdout.trim();
  if (!/^[01]{5}$/.test(digits)) return NO_PANE_MODES;
  const on = (index: number): boolean => digits[index] === "1";
  // Highest mode wins: tmux sets each flag for the DECSET the application sent, and 1003 reports
  // everything 1002 and 1000 do.
  const tracking = on(3) ? 1003 : on(2) ? 1002 : on(1) ? 1000 : 0;
  return { alternate: on(0), tracking, sgr: on(4) };
};

/**
 * The modes as bytes to write BEFORE a snapshot's screen. Empty when none are set, so an ordinary
 * shell's snapshot is unchanged.
 */
export const modeBytes = (modes: PaneModes): string => {
  let out = "";
  if (modes.alternate) out += `${ESC}[?1049h`;
  if (modes.tracking !== 0) out += `${ESC}[?${String(modes.tracking)}h`;
  if (modes.sgr) out += `${ESC}[?1006h`;
  return out;
};
