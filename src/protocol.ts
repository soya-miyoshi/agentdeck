import type { SessionState } from "./tmux.ts";
import type { Session } from "./registry.ts";

// The wire protocol from plan 002, one socket multiplexed over every attached session. Everything
// is parsed rather than trusted: a client with the token is still a program that can send nonsense.

/**
 * The width of every pane, for every session's whole life - a constant, because tmux does not
 * reflow scrollback. The client's value only until the server states its own (see `hello`).
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
  // The pane's width, stated on connect: what it is actually wrapped to is decided by the PTY this
  // server attached with, and a rebuilt client meets an unrestarted server every time.
  | { t: "hello"; cols: number }
  | { t: "snapshot"; sessionId: string; epoch: string; seq: number; history?: string; data: string }
  | { t: "chunk"; sessionId: string; epoch: string; seq: number; data: string }
  | { t: "state"; sessionId: string; state: SessionState; exitCode?: number }
  | { t: "sessions"; sessions: Session[] }
  // The client-visible heartbeat: a ping frame is invisible to JavaScript, so this is how a client
  // tells "quiet" from "gone". It states the interval, so that bound is not a second constant.
  | { t: "ping"; intervalMs: number }
  | { t: "error"; sessionId?: string; message: string };

// A terminal 1x1 or 100000 wide is a bug or an attack, not a viewport. Generous enough that no real
// device meets them, tight enough that the numbers stay arithmetic.
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

export const isValidDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_DIMENSION &&
  value <= MAX_DIMENSION;

/**
 * The width to render at, given what a `hello` stated, falling back to the constant. The client
 * runs no parser over a server frame, and `terminal.resize(NaN, rows)` renders nothing at all.
 */
export const usablePaneCols = (stated: unknown): number =>
  isValidDimension(stated) ? stated : PANE_COLS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * Parse one client frame: the message, or a sentence saying why not. The client renders those
 * verbatim, so they say what was wrong rather than "invalid message".
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
      // haveEpoch and haveSeq travel together or not at all: a seq without an epoch is a number in
      // no particular space, which is the mistake the epoch exists to prevent.
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
 * The pane's row count: the MINIMUM over currently attached clients, since one tmux client backs N
 * browser ones and the newest would truncate somebody else's tab. Empty resizes nothing.
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
