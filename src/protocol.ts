import type { SessionState } from "./tmux.ts";
import type { Session } from "./registry.ts";

// The wire protocol from plan 002. One socket, multiplexed over every attached session - not one
// socket per tab, because phones background aggressively and re-establishing N sockets on wake is
// N chances to fail.
//
// Everything here is parsed rather than trusted. The socket is authenticated, but a client that
// has the token is still a program that can send nonsense, and a `resize` with cols: -1 or a
// `seq` of "banana" must be a refusal rather than an exception three layers down.

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
  | { t: "snapshot"; sessionId: string; epoch: string; seq: number; history?: string; data: string }
  | { t: "chunk"; sessionId: string; epoch: string; seq: number; data: string }
  | { t: "state"; sessionId: string; state: SessionState; exitCode?: number }
  | { t: "sessions"; sessions: Session[] }
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
 * The pane size for a session: the minimum over CURRENTLY attached clients.
 *
 * One tmux client backs N browser clients, so sizing to the newest would let a phone that was
 * just unlocked reflow somebody else's tab under them. The two ways of being wrong are not
 * equal: a pane smaller than the viewport wastes screen and is obvious, while a pane wider than
 * the viewport wraps every line and is unreadable - and only the first is recoverable by looking
 * at it. tmux's own default is the opposite (`window-size latest`), so this is our arithmetic.
 *
 * An empty set resizes nothing: with no clients attached the pane keeps the last size anyone
 * asked for, which is why this returns undefined rather than a default.
 */
export const paneSize = (
  sizes: Iterable<{ cols: number; rows: number }>,
): { cols: number; rows: number } | undefined => {
  let cols = Number.POSITIVE_INFINITY;
  let rows = Number.POSITIVE_INFINITY;
  let any = false;
  for (const size of sizes) {
    any = true;
    cols = Math.min(cols, size.cols);
    rows = Math.min(rows, size.rows);
  }
  return any ? { cols, rows } : undefined;
};
