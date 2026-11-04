// The terminal's text as a person would select it: rows the terminal soft-wrapped joined back into
// the line that was written, so a long URL is one line again rather than fifty-column pieces.

export interface BufferRow {
  text: string;
  /** True when this row continues the one above it because the terminal wrapped, not a newline. */
  wrapped: boolean;
}

/** Logical lines from buffer rows, trailing blank lines dropped, at most `max` of the newest. */
export const logicalLines = (rows: readonly BufferRow[], max: number): string[] => {
  const lines: string[] = [];
  for (const row of rows) {
    const last = lines.length - 1;
    if (row.wrapped && last >= 0) lines[last] = `${lines[last] ?? ""}${row.text}`;
    else lines.push(row.text);
  }
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - max));
};
