import type { SessionState } from "./tmux.ts";
import type { Session } from "./registry.ts";

// The wire protocol from plan 002. One socket, multiplexed over every attached session - not one
// socket per tab, because phones background aggressively and re-establishing N sockets on wake is
// N chances to fail.
//
// Everything here is parsed rather than trusted. The socket is authenticated, but a client that
// has the token is still a program that can send nonsense, and a `resize` with cols: -1 or a
// `seq` of "banana" must be a refusal rather than an exception three layers down.

/**
 * The width of every pane, for the whole life of every session. Not a default: a constant.
 *
 * tmux does not reflow scrollback. Whatever width the pane had when a line was written is frozen
 * into the history at that width, so a pane whose width follows the attached client leaves a
 * trail of differently-wrapped stretches behind it - and re-wrapping those at the phone's width
 * is what breaks older output mid-column, no matter what the phone reports. Sizing to the
 * viewport therefore cannot be made right; only never moving can. The client fixes itself at the
 * SAME number and scales its font to fit, so what it renders matches what the agent laid out.
 *
 * It lives here, in the protocol, because the two halves agreeing is the whole point and it was
 * written out twice - once in `hub.ts` and once in `TerminalPane.vue` - with nothing to keep them
 * equal. Two constants that must match and do not have to are the wrapping bug back again.
 *
 * One file is still not enough on its own, because the two halves are BUILT and RESTARTED
 * separately: `dist/client` is rebuilt by `pnpm build` and the server's copy is whatever the
 * running process was started with. Changing this number and rebuilding without `make restart`
 * therefore leaves a client rendering 50 columns into a pane tmux is still holding at 40, which
 * looks like dead padding down the right-hand edge rather than like a version skew. So this is the
 * client's value only until the server states its own - see the `hello` frame below.
 *
 * 50 rather than the 40 it started at: the client scales the font so the columns fill the phone,
 * so the column count IS the font size, and 40 columns across a 393pt phone is 16px text. Soya
 * asked for smaller; 50 is about 13px there, which is what it looked like before the pane started
 * using the full width.
 */
export const PANE_COLS = 50;

export interface AttachMessage {
  t: "attach";
  sessionId: string;
  cols: number;
  rows: number;
  haveEpoch?: string;
  haveSeq?: number;
}

export interface DetachMessage {
  t: "detach";
  sessionId: string;
}

export interface InputMessage {
  t: "input";
  sessionId: string;
  data: string;
}

export interface ResizeMessage {
  t: "resize";
  sessionId: string;
  cols: number;
  rows: number;
}

export interface ResyncMessage {
  t: "resync";
  sessionId: string;
  haveEpoch: string;
  haveSeq: number;
}

export type ClientMessage =
  | AttachMessage
  | DetachMessage
  | InputMessage
  | ResizeMessage
  | ResyncMessage;

export type ServerMessage =
  // The pane's width, stated on connect, before anything else. The client cannot work it out and
  // must not assume it: what a pane is actually wrapped to is decided by the PTY this server
  // attached with, and a client built after a `PANE_COLS` change runs against a server started
  // before it every time someone rebuilds without restarting.
  | { t: "hello"; cols: number }
  | { t: "snapshot"; sessionId: string; epoch: string; seq: number; history?: string; data: string }
  | { t: "chunk"; sessionId: string; epoch: string; seq: number; data: string }
  | { t: "state"; sessionId: string; state: SessionState; exitCode?: number }
  | { t: "sessions"; sessions: Session[] }
  // The client-visible heartbeat. A WebSocket ping frame is invisible to JavaScript in a browser,
  // so the client cannot use the server's keepalive to tell "the agent is quiet" from "nothing is
  // arriving". This one is an ordinary data frame, sent on the ping timer regardless of agent
  // activity, and it carries the interval so the client's silence bound is the server's number
  // rather than a second constant that can drift out of step with it.
  | { t: "ping"; intervalMs: number }
  | { t: "error"; sessionId?: string; message: string };

// A terminal that is 1x1 or 100000 wide is not a viewport, it is a bug or an attack. The bounds
// are generous enough that no real device meets them and tight enough that the numbers stay
// arithmetic rather than becoming a resource question.
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

export const isValidDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_DIMENSION &&
  value <= MAX_DIMENSION;

/**
 * The width to render at, given what a `hello` frame stated. Falls back to the compiled constant.
 *
 * The client runs no parser over a server frame, and this is a wire value used as a control
 * parameter rather than as data - `terminal.resize(0, rows)` or `resize(NaN, rows)` is a pane that
 * renders nothing at all, from a server that answered wrongly rather than not at all.
 */
export const usablePaneCols = (stated: unknown): number =>
  isValidDimension(stated) ? stated : PANE_COLS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * Parse one client frame.
 *
 * Returns the message, or a sentence saying why not. Errors are sentences the client renders
 * verbatim - rewording a refusal on the client loses the advice it contained - so they say what
 * was wrong rather than "invalid message".
 */
export const parseClientMessage = (raw: string): { message: ClientMessage } | { error: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "message is not JSON" };
  }
  if (!isRecord(parsed)) return { error: "message is not an object" };

  const sessionId = str(parsed["sessionId"]);
  if (sessionId === undefined) return { error: "message has no sessionId" };

  switch (parsed["t"]) {
    case "attach": {
      const { cols, rows } = parsed;
      if (!isValidDimension(cols) || !isValidDimension(rows)) {
        return {
          error: `attach needs integer cols and rows between 1 and ${String(MAX_DIMENSION)}`,
        };
      }
      const message: AttachMessage = { t: "attach", sessionId, cols, rows };
      // haveEpoch and haveSeq travel together or not at all. A seq without an epoch is a number
      // in no particular space, and treating it as a position is exactly the mistake the epoch
      // exists to prevent.
      const haveEpoch = str(parsed["haveEpoch"]);
      const haveSeq = parsed["haveSeq"];
      if (haveEpoch !== undefined && typeof haveSeq === "number" && Number.isInteger(haveSeq)) {
        message.haveEpoch = haveEpoch;
        message.haveSeq = haveSeq;
      }
      return { message };
    }
    case "detach":
      return { message: { t: "detach", sessionId } };
    case "input": {
      const data = parsed["data"];
      if (typeof data !== "string") return { error: "input needs string data" };
      return { message: { t: "input", sessionId, data } };
    }
    case "resize": {
      const { cols, rows } = parsed;
      if (!isValidDimension(cols) || !isValidDimension(rows)) {
        return {
          error: `resize needs integer cols and rows between 1 and ${String(MAX_DIMENSION)}`,
        };
      }
      return { message: { t: "resize", sessionId, cols, rows } };
    }
    case "resync": {
      const haveEpoch = str(parsed["haveEpoch"]);
      const haveSeq = parsed["haveSeq"];
      if (haveEpoch === undefined || typeof haveSeq !== "number" || !Number.isInteger(haveSeq)) {
        return { error: "resync needs haveEpoch and an integer haveSeq" };
      }
      return { message: { t: "resync", sessionId, haveEpoch, haveSeq } };
    }
    default:
      return { error: `unknown message type: ${String(parsed["t"])}` };
  }
};

/**
 * The pane's row count for a session: the minimum over CURRENTLY attached clients.
 *
 * Only rows. The width is a constant the server owns (`PANE_COLS`), because tmux does not reflow
 * scrollback: every width the pane has ever had is frozen into the history at that width, and a
 * client re-wrapping it at its own width is what makes older output break mid-column. A width
 * that never moves is the only version of this with no wrong answer.
 *
 * Rows still follow the clients, and the minimum rather than the newest: one tmux client backs N
 * browser clients, so sizing to the newest would truncate somebody else's tab under them. An
 * empty set resizes nothing - the pane keeps the last size anyone asked for - which is why this
 * returns undefined rather than a default.
 */
export const paneRows = (sizes: Iterable<{ rows: number }>): number | undefined => {
  let rows = Number.POSITIVE_INFINITY;
  let any = false;
  for (const size of sizes) {
    any = true;
    rows = Math.min(rows, size.rows);
  }
  return any ? rows : undefined;
};
