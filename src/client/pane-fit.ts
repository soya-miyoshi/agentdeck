// How big the font must be for the fixed column count to fill the pane, kept out of the component
// so it is testable. Neither input is exact: the addon reports WHOLE columns and reserves width.

/** The narrowest and widest the deck will size its text, whatever the pane's width asks for. */
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 24;

/**
 * CSS pixels of cell width per pixel of font size, from one observation - `reserved` added back so
 * the ratio describes the font. Measure at a SMALL font: more columns, less floor error.
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
 * The font size at which `columns` cells fill `width`, clamped and NOT rounded - a floored font is
 * narrow on every column at once. One pixel is held back, because a clipped last column is worse.
 */
export const fontSizeFor = (width: number, columns: number, cellPerFontPx: number): number => {
  if (!(cellPerFontPx > 0) || columns <= 0) return MIN_FONT_SIZE;
  const exact = (width - 1) / columns / cellPerFontPx;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, exact));
};
