// What the Login panel reads off a pane and puts back on it, testable without a DOM. `/login` prints
// its URL across several terminal rows and a phone cannot select any of them.

/** The start of the address `/login` prints: an https URL whose path goes through an OAuth authorize. */
const URL_START = /https:\/\/\S*oauth\/authorize\S*/;

/**
 * The newest login URL in these rows, rejoined. A row continues the URL only when the one before it
 * reached the right edge: tmux redraws the pane row by row, so xterm never sees it as one wrapped line.
 */
export const loginUrl = (rows: readonly string[], cols: number): string | undefined => {
  for (let start = rows.length - 1; start >= 0; start -= 1) {
    const match = URL_START.exec(rows[start] ?? "");
    if (match === null) continue;
    let url = match[0];
    let row = rows[start] ?? "";
    for (let next = start + 1; next < rows.length; next += 1) {
      if (row.trimEnd().length < cols) break;
      row = rows[next] ?? "";
      // A continuation is one unbroken run: a row with a space in it is prose after the URL.
      if (!/^\s*\S+$/.test(row.trimEnd())) break;
      url += row.trim();
    }
    return trusted(url) ? url : undefined;
  }
  return undefined;
};

/** The hosts a sign-in may be offered for. Anything in a pane can print an authorize-shaped URL. */
const HOSTS = ["claude.com", "claude.ai", "anthropic.com"];

const trusted = (url: string): boolean => {
  try {
    const host = new globalThis.URL(url).hostname;
    return HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
};

/**
 * The URL the panel shows after a re-read. A miss keeps the last one: a repaint clears the pane for a
 * moment, and flipping the panel then remounts the code field under the thumb typing into it.
 */
export const keptUrl = (shown: string | undefined, found: string | undefined): string | undefined =>
  found ?? shown;

/**
 * The bytes that hand a pasted code to the prompt. Whitespace is dropped everywhere, not only at the
 * ends: a code has none, and a phone's paste brings a trailing newline that would reach the prompt.
 */
export const codeBytes = (pasted: string): string => {
  const code = pasted.replace(/\s+/g, "");
  return code === "" ? "" : `${code}\r`;
};
