// The arithmetic that decides how big the font has to be for the deck's fixed column count to
// fill the pane. Separated from `TerminalPane.vue` for the reason `key-row.ts` is: it is a rule
// about numbers, and the alternative is a test that runs a browser-only component on the host.
//
// The whole problem is that neither number involved is exact. `FitAddon.proposeDimensions` reports
// WHOLE columns, so the cell width read back from it carries the error of that floor; and the
// addon quietly subtracts a reserve from the width before dividing.

/** The narrowest and widest the deck will size its text, whatever the pane's width asks for. */
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 24;

/**
 * CSS pixels of cell width per pixel of font size, from one observation of the addon.
 *
 * `reserved` is what the addon took off the width before dividing, added back so the ratio
 * describes the font rather than the addon. Undefined when the observation cannot support a
 * ratio - a pane not laid out yet, or so few columns that the floor dominates - because this is
 * measured once and a wrong ratio would never be corrected.
 *
 * Measure at a SMALL font: the floor's error is one column in `cols`, so the more columns the
 * observation has, the better the ratio. At a font that nearly fills the pane there are only 40.
 */
export const cellRatio = (
  width: number,
  reserved: number,
  cols: number,
  fontSize: number,
  minCols: number,
): number | undefined => {
  if (!(width > reserved) || !(fontSize > 0) || cols < minCols || cols <= 0) return undefined;
  return (width - reserved) / cols / fontSize;
};

/**
 * The font size at which `columns` cells fill `width`, clamped, and NOT rounded to a whole pixel.
 *
 * Rounding was the defect this replaced. A font floored to the pixel below is up to a whole step
 * of cell width narrow on every column, and at 40 columns that is tens of pixels of dead margin
 * down the right-hand edge of the phone.
 *
 * One pixel is held back from the width: a cell that rounds up rather than down inside the
 * terminal clips the last column, and a column that is present but unreadable is worse than a
 * pixel of margin.
 */
export const fontSizeFor = (width: number, columns: number, cellPerFontPx: number): number => {
  if (!(cellPerFontPx > 0) || columns <= 0) return MIN_FONT_SIZE;
  const exact = (width - 1) / columns / cellPerFontPx;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, exact));
};
