// How a snapshot's scrollback is written before its live screen. The screen is drawn with absolute
// cursor moves over the visible rows, so history still on those rows would be drawn over and lost.

/**
 * History, then exactly `rows` newlines: whatever row the history ended on, that scrolls every row
 * of it into scrollback and leaves a blank screen for the repaint to draw on.
 */
export const historyBytes = (history: string, rows: number): string =>
  history === "" ? "" : `${history}${"\r\n".repeat(Math.max(1, rows))}`;
