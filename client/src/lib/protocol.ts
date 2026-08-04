// The wire shapes from plan 002, as the client sees them.
//
// `src/protocol.ts` on the server is the authority; these are restated rather than imported
// because the client is bundled by Vite and the server modules it would pull in reach for
// `node:crypto` two hops down. Nothing here may add a field the server does not send.

export type SessionState = "working" | "waiting" | "idle" | "exited";

export interface Session {
  id: string;
  name: string;
  cwd: string;
  agent: string;
  state: SessionState;
  startedAt: number;
  exitCode?: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  available: boolean;
  detectsWaiting: boolean;
}

export type ClientMessage =
  | { t: "attach"; sessionId: string; cols: number; rows: number; haveEpoch?: string; haveSeq?: number }
  | { t: "detach"; sessionId: string }
  | { t: "input"; sessionId: string; data: string }
  | { t: "resize"; sessionId: string; cols: number; rows: number }
  | { t: "resync"; sessionId: string; haveEpoch: string; haveSeq: number };

export type ServerMessage =
  | { t: "snapshot"; sessionId: string; epoch: string; seq: number; history?: string; data: string }
  | { t: "chunk"; sessionId: string; epoch: string; seq: number; data: string }
  | { t: "state"; sessionId: string; state: SessionState; exitCode?: number }
  | { t: "sessions"; sessions: Session[] }
  | { t: "error"; sessionId?: string; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse one server frame.
 *
 * The client trusts the server rather less than the server trusts the client - not because it
 * expects malice, but because a frame that is one field short must degrade into "ignored" rather
 * than into an exception inside the render path, which on a phone is a blank tab with no way to
 * ask what happened.
 */
export const parseServerMessage = (raw: string): ServerMessage | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const sessionId = typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined;
  const epoch = typeof parsed["epoch"] === "string" ? parsed["epoch"] : undefined;
  const seq = typeof parsed["seq"] === "number" ? parsed["seq"] : undefined;
  const data = typeof parsed["data"] === "string" ? parsed["data"] : undefined;

  switch (parsed["t"]) {
    case "snapshot": {
      if (sessionId === undefined || epoch === undefined || seq === undefined || data === undefined)
        return undefined;
      const history = typeof parsed["history"] === "string" ? parsed["history"] : undefined;
      return history === undefined
        ? { t: "snapshot", sessionId, epoch, seq, data }
        : { t: "snapshot", sessionId, epoch, seq, history, data };
    }
    case "chunk":
      if (sessionId === undefined || epoch === undefined || seq === undefined || data === undefined)
        return undefined;
      return { t: "chunk", sessionId, epoch, seq, data };
    case "state": {
      const state = parsed["state"];
      if (sessionId === undefined || typeof state !== "string") return undefined;
      if (state !== "working" && state !== "waiting" && state !== "idle" && state !== "exited")
        return undefined;
      const exitCode = typeof parsed["exitCode"] === "number" ? parsed["exitCode"] : undefined;
      return exitCode === undefined
        ? { t: "state", sessionId, state }
        : { t: "state", sessionId, state, exitCode };
    }
    case "sessions": {
      const sessions = parsed["sessions"];
      if (!Array.isArray(sessions)) return undefined;
      return { t: "sessions", sessions: sessions as Session[] };
    }
    case "error": {
      const message = parsed["message"];
      if (typeof message !== "string") return undefined;
      return sessionId === undefined
        ? { t: "error", message }
        : { t: "error", sessionId, message };
    }
    default:
      return undefined;
  }
};
