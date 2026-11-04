// What the Go server (server-go/) sends and accepts, as the client's own types. The server's Go
// structs are the authority; server-go/ws.go and server-go/registry.go carry the same shapes.

export type SessionState = "working" | "waiting" | "idle" | "exited";

export interface Session {
  id: string;
  name: string;
  cwd: string;
  agent: string;
  state: SessionState;
  startedAt: number;
  exitCode?: number;
  /** True when this session's hooks are refused, so `waiting` is the one state it cannot reach. */
  waitingDetectionLost?: true;
}

/** GET /api/agents. `available` lets the picker grey out an agent it cannot start. */
export interface AgentSummary {
  id: string;
  name: string;
  available: boolean;
  detectsWaiting: boolean;
}

/** GET /api/cwds: an allowlisted directory and the live sessions already in it. */
export interface Cwd {
  path: string;
  name: string;
  sessions: string[];
}

/** The pane width until the server states its own in `hello`. Matches `paneCols` in server-go/hub.go. */
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
  | { t: "hello"; cols: number }
  | {
      t: "snapshot";
      sessionId: string;
      epoch: string;
      seq: number;
      history?: string;
      data: string;
      modes?: string;
    }
  | { t: "chunk"; sessionId: string; epoch: string; seq: number; data: string }
  | { t: "state"; sessionId: string; state: SessionState; exitCode?: number }
  | { t: "sessions"; sessions: Session[] }
  | { t: "ping"; intervalMs: number }
  | { t: "error"; sessionId?: string; message: string };

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

export const isValidDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_DIMENSION &&
  value <= MAX_DIMENSION;

/** The width a `hello` stated, or the constant: `terminal.resize(NaN, rows)` renders nothing. */
export const usablePaneCols = (stated: unknown): number =>
  isValidDimension(stated) ? stated : PANE_COLS;

// The server's socket limits, which the client paces itself under. server-go/wire_test.go fails if
// these drift from the constants in server-go/ws.go.
export const PING_INTERVAL_MS = 15_000;
export const MAX_FRAMES_PER_WINDOW = 100;
export const MAX_FRAME_BYTES = 64 * 1024;
