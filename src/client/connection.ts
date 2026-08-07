import type { ClientMessage, ServerMessage } from "../protocol.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";
import { ReconnectPolicy } from "./backoff.ts";
import {
  receiveChunk,
  receiveSnapshot,
  type Position,
  type RenderAction,
} from "./stream-position.ts";

// ONE socket, multiplexed over every attached session. Not one per tab: phones background
// aggressively, and re-establishing N sockets on wake is N chances to fail.
//
// The browser's WebSocket is behind a factory so this whole file can be tested under node:test
// without a browser. That is not a testing convenience bolted on afterwards - the reconnection
// ladder is the part of the client most likely to be wrong and least likely to be noticed, and it
// is unreachable from a rendering test.

export interface SocketHandlers {
  opened: () => void;
  message: (raw: string) => void;
  /** Closed or failed. The client cannot tell those apart, which is why `verifyToken` exists. */
  closed: () => void;
}

export interface SocketLike {
  send: (raw: string) => void;
  close: () => void;
}

export type SocketFactory = (token: string, handlers: SocketHandlers) => SocketLike;

/** Cancel a scheduled reconnect. */
export type Cancel = () => void;

/**
 * The largest `input` frame this client will put on the wire, in bytes of serialised JSON.
 *
 * The server's receiver caps a frame at 64 KiB (`MAX_FRAME_BYTES` in src/ws.ts) and `ws` enforces
 * that BEFORE the `message` event, so an over-size frame cannot be answered with an `error` frame -
 * the socket is closed with 1009 instead. From here that close is indistinguishable from a phone
 * in a lift: the ladder runs, every tab re-attaches, each re-attach a cold snapshot with a real
 * capture-pane, and the paste is gone with no explanation. xterm delivers a paste as ONE onData
 * event, and 15-30 KB of log or diff is enough once JSON escaping inflates it, so this is an
 * ordinary paste rather than an abuse.
 *
 * So the chunking is here, on the sending side, where the size is known before the frame exists.
 * The number is below the server's cap rather than equal to it because the value that matters is
 * the frame the server measures, and leaving the last kilobyte unclaimed costs nothing.
 * src/client/connection.test.ts asserts the two agree.
 */
export const MAX_INPUT_FRAME_BYTES = 60 * 1024;

/**
 * How long an input window lasts here, and how many `input` frames may be released in one.
 *
 * The server drops the rest of a window once a socket goes past MAX_FRAMES_PER_WINDOW (100) in
 * RATE_WINDOW_MS (1 s) - it does not close the socket and it does not refuse the message, so an
 * unpaced multi-megabyte paste is applied to the pty with a hole in the middle of it. A hole is
 * worse than a refusal: the shell then runs the concatenation of two fragments nobody typed, and
 * a bracketed paste can lose its closing ESC[201~ and leave the receiving application in paste
 * mode. So the pieces are queued here and released a window at a time, in order.
 *
 * The number is well under the server's because our window and the server's start at different
 * moments: a burst that straddles the boundary spends its budget against two of our windows but
 * one of theirs. Half the server's budget is the value that cannot straddle into a drop.
 * src/client/connection.test.ts asserts the two agree.
 */
export const INPUT_WINDOW_MS = 1000;
export const MAX_INPUT_FRAMES_PER_WINDOW = 40;

const encoder = new TextEncoder();

export interface ConnectionDeps {
  token: string;
  connect: SocketFactory;
  /**
   * Whether the server still accepts this token, as one cheap authenticated request.
   *
   * A browser never sees the 401 from a rejected WebSocket upgrade - it reports the same "closed
   * before open" it reports for a phone in a lift - so the two are told apart by asking over
   * HTTP, where the status code survives. Getting this wrong in the safe-looking direction means
   * backing off forever against a server that is answering correctly, which looks exactly like
   * being out of range.
   */
  verifyToken: () => Promise<boolean>;
  schedule?: (run: () => void, delayMs: number) => Cancel;
}

export interface ConnectionEvents {
  /** What to do with this session's terminal. Already resolved against the tracked position. */
  render: (sessionId: string, action: Extract<RenderAction, { kind: "repaint" | "write" }>) => void;
  state: (sessionId: string, state: SessionState, exitCode: number | undefined) => void;
  sessions: (sessions: Session[]) => void;
  /** A sentence written by the server, rendered verbatim - rewording it loses its advice. */
  error: (sessionId: string | undefined, message: string) => void;
  status: (status: ConnectionStatus) => void;
  /** The token was rejected. Drop what is stored and show the paste field. */
  unauthorized: () => void;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "rejected" | "closed";

interface Attachment {
  cols: number;
  rows: number;
  position?: Position;
}

const defaultSchedule = (run: () => void, delayMs: number): Cancel => {
  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export class Connection {
  #deps: ConnectionDeps;
  #events: ConnectionEvents;
  #schedule: (run: () => void, delayMs: number) => Cancel;
  #policy = new ReconnectPolicy();
  #socket: SocketLike | undefined;
  #opened = false;
  #stopped = false;
  #cancelRetry: Cancel | undefined;
  #attachments = new Map<string, Attachment>();
  #status: ConnectionStatus = "closed";
  /** Serialised `input` frames waiting for room in the window, oldest first. */
  #pendingInput: string[] = [];
  #framesThisWindow = 0;
  #cancelWindow: Cancel | undefined;

  constructor(deps: ConnectionDeps, events: ConnectionEvents) {
    this.#deps = deps;
    this.#events = events;
    this.#schedule = deps.schedule ?? defaultSchedule;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /** The position each attached session has been rendered to. Exposed for tests. */
  positionOf(sessionId: string): Position | undefined {
    return this.#attachments.get(sessionId)?.position;
  }

  start(): void {
    this.#stopped = false;
    this.#open("connecting");
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#resetInputWindow();
    this.#setStatus("closed");
  }

  /**
   * Attach, or re-declare an existing attachment's size.
   *
   * The attachment set is kept across reconnects on purpose: it is exactly the list of tabs to
   * re-attach on the next open, each with the epoch and seq it got to.
   */
  attach(sessionId: string, cols: number, rows: number): void {
    const existing = this.#attachments.get(sessionId);
    if (existing === undefined) {
      this.#attachments.set(sessionId, { cols, rows });
    } else {
      existing.cols = cols;
      existing.rows = rows;
    }
    this.#sendAttach(sessionId);
  }

  detach(sessionId: string): void {
    if (!this.#attachments.delete(sessionId)) return;
    this.#send({ t: "detach", sessionId });
  }

  /**
   * Raw bytes the user typed, as one `input` frame or as many as it takes to stay under the
   * receiver's cap.
   *
   * Nothing is rendered here. Input comes back as ordinary output because that is what a PTY
   * does, and the agent may be in a mode that transforms or refuses it - so optimistically
   * painting the character would be the client asserting something only the agent knows.
   *
   * Each cut is as late as the cap allows, found by measuring the frame that will actually be
   * sent rather than by assuming the worst escaping every character could have (six bytes, for a
   * control character), which would cut an ordinary ASCII paste into six times as many frames as
   * it needs. Halving instead of cutting greedily was the other way to be wrong: it rounds up to
   * the next power of two, so the pieces average half the cap and the paste costs twice the
   * frames. The cut steps back off a lone high surrogate, because half a code point is not the
   * same bytes at the other end.
   *
   * The pieces stay in order and are released against a frame budget - see INPUT_WINDOW_MS. A PTY
   * has no notion of message boundaries, so N frames written back to back are the same byte stream
   * as one; what it does not survive is a frame going missing from the middle.
   */
  input(sessionId: string, data: string): void {
    let rest = data;
    while (rest.length > 0) {
      const cut = this.#cut(sessionId, rest);
      this.#queueInput({ t: "input", sessionId, data: rest.slice(0, cut) });
      rest = rest.slice(cut);
    }
  }

  /** How many characters of `data` fit in one frame: the largest prefix under the cap. */
  #cut(sessionId: string, data: string): number {
    const fits = (n: number): boolean =>
      encoder.encode(JSON.stringify({ t: "input", sessionId, data: data.slice(0, n) })).length <=
      MAX_INPUT_FRAME_BYTES;
    // No character serialises to less than one byte, so a piece can never be longer than the cap.
    let hi = Math.min(data.length, MAX_INPUT_FRAME_BYTES);
    if (fits(hi)) return hi;
    let lo = 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    // A single code point that does not fit cannot be split further, and there is no such code
    // point: the cap is kilobytes and the largest code point is four bytes.
    const code = data.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff && lo > 1) lo -= 1;
    return lo;
  }

  #queueInput(message: ClientMessage): void {
    this.#pendingInput.push(JSON.stringify(message));
    this.#flushInput();
  }

  #flushInput(): void {
    if (this.#socket === undefined) {
      // The same rule as #send: nothing is held across a disconnect, because a keystroke arriving
      // seconds later lands in whatever the agent is doing by then.
      this.#pendingInput.length = 0;
      return;
    }
    while (this.#pendingInput.length > 0 && this.#framesThisWindow < MAX_INPUT_FRAMES_PER_WINDOW) {
      if (this.#framesThisWindow === 0) {
        this.#cancelWindow = this.#schedule(() => {
          this.#cancelWindow = undefined;
          this.#framesThisWindow = 0;
          this.#flushInput();
        }, INPUT_WINDOW_MS);
      }
      this.#framesThisWindow += 1;
      this.#socket.send(this.#pendingInput.shift() as string);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const attachment = this.#attachments.get(sessionId);
    if (attachment === undefined) return;
    attachment.cols = cols;
    attachment.rows = rows;
    this.#send({ t: "resize", sessionId, cols, rows });
  }

  /**
   * Try again now, without waiting out the backoff.
   *
   * For the moments the browser tells us something changed - the tab came back to the foreground,
   * the network came back. Waiting out a delay that was scheduled while the phone was in a pocket
   * is latency for no information.
   */
  poke(): void {
    if (this.#stopped || this.#socket !== undefined) return;
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
    this.#open(this.#status === "reconnecting" ? "reconnecting" : "connecting");
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#events.status(status);
  }

  #open(status: ConnectionStatus): void {
    this.#opened = false;
    this.#setStatus(status);
    this.#socket = this.#deps.connect(this.#deps.token, {
      opened: () => {
        this.#opened = true;
        this.#policy.opened();
        this.#setStatus("open");
        // Re-attach every tab with where it got to. The server answers with chunks if the epoch
        // matches and its buffer still covers that point, and a snapshot otherwise - and the
        // snapshot case is the common one after the phone has been asleep.
        for (const sessionId of this.#attachments.keys()) this.#sendAttach(sessionId);
      },
      message: (raw) => {
        this.#receive(raw);
      },
      closed: () => {
        void this.#onClosed();
      },
    });
  }

  /** A new socket starts a new budget, and nothing queued for the old one is still wanted. */
  #resetInputWindow(): void {
    this.#pendingInput.length = 0;
    this.#framesThisWindow = 0;
    this.#cancelWindow?.();
    this.#cancelWindow = undefined;
  }

  async #onClosed(): Promise<void> {
    this.#socket = undefined;
    this.#resetInputWindow();
    if (this.#stopped) return;

    // A socket that never opened may be a rejected token wearing a network failure's clothes.
    // One that opened and then dropped cannot be: the server accepted this token seconds ago.
    if (!this.#opened && !(await this.#deps.verifyToken())) {
      this.#policy.closed("token-rejected");
      this.#stopped = true;
      this.#setStatus("rejected");
      this.#events.unauthorized();
      return;
    }
    if (this.#stopped) return;

    const decision = this.#policy.closed("network");
    if (!decision.retry) return;
    if (decision.showReconnecting) this.#setStatus("reconnecting");
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = undefined;
      if (this.#stopped) return;
      this.#open(this.#status === "reconnecting" ? "reconnecting" : "connecting");
    }, decision.delayMs);
  }

  #sendAttach(sessionId: string): void {
    const attachment = this.#attachments.get(sessionId);
    if (attachment === undefined) return;
    const message: ClientMessage = {
      t: "attach",
      sessionId,
      cols: attachment.cols,
      rows: attachment.rows,
    };
    // haveEpoch and haveSeq travel together or not at all: a seq without an epoch is a position
    // in no particular space, which is the mistake the epoch exists to prevent.
    if (attachment.position !== undefined) {
      message.haveEpoch = attachment.position.epoch;
      message.haveSeq = attachment.position.seq;
    }
    this.#send(message);
  }

  #send(message: ClientMessage): void {
    // Dropped rather than queued while disconnected. Everything the server needs to catch up is
    // re-sent on open from the attachment set, and a queued keystroke arriving seconds later
    // lands in whatever the agent is doing by then.
    this.#socket?.send(JSON.stringify(message));
  }

  #receive(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.#events.error(undefined, "the server sent something that is not JSON");
      return;
    }
    switch (message.t) {
      case "snapshot":
        this.#apply(message.sessionId, receiveSnapshot(message));
        return;
      case "chunk":
        this.#apply(message.sessionId, receiveChunk(this.positionOf(message.sessionId), message));
        return;
      case "state":
        this.#events.state(message.sessionId, message.state, message.exitCode);
        return;
      case "sessions":
        this.#events.sessions(message.sessions);
        return;
      case "error":
        this.#events.error(message.sessionId, message.message);
        return;
    }
  }

  #apply(sessionId: string, action: RenderAction): void {
    const attachment = this.#attachments.get(sessionId);
    switch (action.kind) {
      case "ignore":
        return;
      case "resync":
        // A gap, rather than a hole rendered into the pane. The missing bytes are usually the
        // escape sequence that would have reset the colour.
        this.#send({
          t: "resync",
          sessionId,
          haveEpoch: action.haveEpoch,
          haveSeq: action.haveSeq,
        });
        return;
      default:
        if (attachment !== undefined) attachment.position = action.position;
        this.#events.render(sessionId, action);
        return;
    }
  }
}
