import qrcode from "qrcode-generator";

// The sixth and last runtime dependency, spent here on purpose: plan 003's guardrail names a QR
// encoder as the one addition worth making, because the alternative is hand-typing a 43-character
// random string into a phone, which is the behaviour that ends with the token in a note.
//
// `qrcode-generator@2.0.4`, MIT, zero transitive dependencies. It is server-side only - the QR is
// printed to a terminal - so nothing under `src/client` imports it and it never reaches the
// browser bundle. `src/qr.test.ts` asserts both of those, and decodes the encoder's output back
// to the string that went in rather than trusting the blocks by eye.
//
// Read, not skimmed: it is one file of plain JavaScript with no I/O, no globals and no `eval`.
// Two facts from reading it that this module depends on:
//
//   - `qrcode.stringToBytes` is `charCodeAt(i) & 0xff`, i.e. latin-1, not UTF-8. Anything outside
//     U+00FF would be silently truncated to a different byte. Everything encoded here is a
//     base64url token, whose alphabet is `A-Z a-z 0-9 - _`, so the truncation cannot bite.
//   - `make()` with type number 0 picks the smallest version that fits, then tries all eight
//     masks and keeps the one with the lowest penalty score. So the mask is chosen, not fixed,
//     and a decoder has to read the format information rather than assume mask 0 - which is what
//     the test does.

// Error correction level. M is 15% recovery: a code photographed off a terminal has no print
// damage, but it does get a cursor, a scrollbar or a reflection across it. L is the level that
// makes those fail; Q and H buy nothing here and make the code larger on a screen that has to fit
// it beside the URL.
const ERROR_CORRECTION = "M";

// The quiet zone the spec requires. Without it a scanner will not find the finder patterns
// against whatever text is on the line above.
const QUIET_MODULES = 4;

const RESET = "\u001b[0m";
const UPPER_HALF = "▀";

/**
 * The module grid, row-major, `true` for a dark module.
 *
 * Exported because this is what a decoder can be run against: the rendering below is a lossy view
 * of it, and asserting on the rendering would be asserting on the ANSI codes rather than on the
 * code.
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
 * The grid as terminal lines, two module rows per text line.
 *
 * Half blocks rather than two spaces per module: a version-3 code is 29 modules plus 8 of quiet
 * zone, which at two columns per module is 74 columns wide and 37 lines tall. Half blocks make it
 * 37 by 19, which fits a terminal window someone actually has open.
 *
 * The colours are set explicitly, both foreground and background, instead of relying on the
 * terminal's own. A QR code is dark-on-light; on a dark terminal theme, blocks drawn in the
 * default foreground colour produce an inverted code, and inverted codes are the ones that scan
 * on one phone and not on another.
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
 * What the terminal shows on first run.
 *
 * **The QR carries the bare token, and not a URL with the token in it.** That is the whole
 * decision, and it goes the other way from the obvious one. A URL like
 * `https://host/?token=...` would let a camera app open the app already signed in, in one tap -
 * and would also write the credential into the phone's browser history, into the `Referer` header
 * of every outbound request the page makes, and into the logs of anything in front of the server.
 * This is the token plan 002 says starts sessions in every allowed repository, kills live ones,
 * and attaches to every other agent's terminal; plan 001 already refuses to accept it from a
 * query string for exactly these reasons, so putting it in one here would be defeating our own
 * rule from the other side. A fragment (`#token=...`) is not sent to the server, but still lands
 * in history. The token alone costs one paste and leaks nowhere.
 *
 * The URL is printed beside it as text, which is what plan 001 describes. It is not a secret, it
 * is typed once per device, and the app is then installed to the home screen.
 */
export const firstRunLines = (token: string, url: string, tokenFile: string): string[] => [
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

/**
 * The URL to print beside the QR.
 *
 * Not derived and not guessed. `AGENTDECK_ORIGIN` is the origin the operator has already told the
 * server the phone loads, so when it is set it is the answer. When it is not, the only URL this
 * process can honestly claim is the one it is listening on: it binds loopback, and whether a
 * `tailscale serve` in front of it exists, and on what hostname, is not knowable from here.
 * `m4/tailscale-serve` is not merged and HTTPS is not enabled on this tailnet, so a
 * `https://<host>.ts.net` URL printed today would be a URL that does not answer.
 */
export const clientUrl = (origin: string | undefined, port: number): string =>
  origin ?? `http://127.0.0.1:${String(port)}`;
