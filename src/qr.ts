import qrcode from "qrcode-generator";

// The sixth and last runtime dependency (plan 003), server-side only. Its `stringToBytes` is
// latin-1, which base64url survives, and `make()` CHOOSES the mask rather than fixing it at 0.

// M is 15% recovery: a code photographed off a terminal gets a cursor or a reflection across it,
// which is what L fails on. Q and H only make it larger beside the URL.
const ERROR_CORRECTION = "M";

// The quiet zone the spec requires: without it a scanner cannot find the finder patterns against
// whatever text is on the line above.
const QUIET_MODULES = 4;

const RESET = "\u001b[0m";
const UPPER_HALF = "▀";

/**
 * The module grid, row-major, `true` for a dark module. Exported because a decoder runs against
 * this: the rendering below is a lossy view, so asserting on it would assert on the ANSI codes.
 */
export const qrModules = (text: string): boolean[][] => {
  const code = qrcode(0, ERROR_CORRECTION);
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => code.isDark(row, col)),
  );
};

/**
 * The grid as terminal lines, two module rows per text line - half blocks fit a real window where
 * two spaces per module does not. Both colours are set: a dark theme would invert the code.
 */
export const qrLines = (text: string): string[] => {
  const modules = qrModules(text);
  const width = modules.length + QUIET_MODULES * 2;
  const dark = (row: number, col: number): boolean =>
    modules[row - QUIET_MODULES]?.[col - QUIET_MODULES] ?? false;

  const lines: string[] = [];
  for (let row = 0; row < width; row += 2) {
    let line = "";
    for (let col = 0; col < width; col += 1) {
      // Foreground paints the upper half, background the lower. A row past the bottom edge is
      // quiet zone, which is light.
      const top = dark(row, col) ? "30" : "97";
      const bottom = dark(row + 1, col) ? "40" : "107";
      line += `\u001b[${top};${bottom}m${UPPER_HALF}`;
    }
    lines.push(line + RESET);
  }
  return lines;
};

/**
 * What the terminal shows on first run. The QR carries the BARE TOKEN, not a URL containing one,
 * and off a terminal no grid is printed at all - the grid IS the credential, and does not look it.
 */
export const firstRunLines = (
  token: string,
  url: string,
  tokenFile: string,
  tty = true,
): string[] =>
  tty
    ? qrFirstRunLines(token, url, tokenFile)
    : [
        "agentdeck: first run. A bearer token was issued and stored in " + tokenFile + ".",
        "agentdeck: stdout is not a terminal, so the QR code was NOT printed - it encodes the",
        "token, and anything that can read this output could decode it back out.",
        `agentdeck: open ${url} on the device and paste the token into the field. To get the`,
        "scannable code, run the server from a terminal; delete the token file first and restart,",
        "which issues a new token and makes that boot a first run again.",
      ];

const qrFirstRunLines = (token: string, url: string, tokenFile: string): string[] => [
  "agentdeck: first run. This is the bearer token as a QR code - scan it with the phone's camera",
  "and paste the text into the token field. The QR carries the token only, deliberately: a URL",
  "with the token in it would leave the credential in browser history and in every Referer header.",
  "",
  ...qrLines(token),
  "",
  `agentdeck: open ${url} on the device, then paste the scanned token there.`,
  `agentdeck: the token is stored in ${tokenFile}. Delete it and restart to issue a new one -`,
  "there is one token, not one per device, so that invalidates every client at once.",
];

/** The URL to print beside the QR: `AGENTDECK_ORIGIN` when the operator has set it, else the
 *  loopback address, because whether a `tailscale serve` fronts this port is not knowable here. */
export const clientUrl = (origin: string | undefined, port: number): string =>
  origin ?? `http://127.0.0.1:${String(port)}`;
