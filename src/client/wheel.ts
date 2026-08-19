// Turning a touch drag into scrolling, as a pure decision. An app on the alternate screen keeps its
// own transcript and the terminal has no scrollback there, so scrolling locally shows nothing.

/** What the pane should do with a drag, given the mouse mode the APPLICATION set. */
export type ScrollTarget = "local" | "application";

/**
 * Where the lines go. `x10` reports button presses only and has no wheel, so it stays local; every
 * mode above it reports the wheel, which is what a transcript-owning TUI listens for.
 */
export const scrollTarget = (
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any",
): ScrollTarget =>
  mouseTrackingMode === "none" || mouseTrackingMode === "x10" ? "local" : "application";

/**
 * One SGR wheel report (1006). SGR rather than the legacy `CSI M` encoding, which cannot address a
 * column past 223 - the cost is that an app tracking the mouse without 1006 reads these as text.
 */
export const wheelBytes = (direction: "up" | "down", col: number, row: number): string => {
  const button = direction === "up" ? 64 : 65;
  const c = Math.max(1, Math.trunc(col));
  const r = Math.max(1, Math.trunc(row));
  return `\x1b[<${String(button)};${String(c)};${String(r)}M`;
};

/** A drag of `lines` rows as wheel reports: a negative delta is earlier output, so a wheel up. */
export const wheelDrag = (lines: number, col: number, row: number): string => {
  const count = Math.abs(Math.trunc(lines));
  if (count === 0) return "";
  return wheelBytes(lines < 0 ? "up" : "down", col, row).repeat(count);
};
