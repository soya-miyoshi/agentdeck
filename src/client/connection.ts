import { usablePaneCols, type ClientMessage, type ServerMessage } from "../protocol.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";
import type { TokenVerdict } from "./api.ts";
import { ReconnectPolicy } from "./backoff.ts";
import {
  receiveChunk,
  receiveSnapshot,
  type Position,
  type RenderAction,
} from "./stream-position.ts";

// ONE socket multiplexed over every attached session: phones background aggressively, and N sockets
// is N chances to fail on wake. The WebSocket is behind a factory so this file runs under node:test.

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
 * The largest `input` frame this client will send. `ws` enforces the server's 64 KiB cap BEFORE the
 * message event, so an over-size frame closes the socket rather than earning an `error` frame.
 */
export const MAX_INPUT_FRAME_BYTES = 60 * 1024;

/**
 * How long an input window lasts here, and how many `input` frames it may release in one. The
 * server silently drops the rest of ITS window, and ours straddle theirs - hence half its budget.
 */
export const INPUT_WINDOW_MS = 1000;
export const MAX_INPUT_FRAMES_PER_WINDOW = 40;

/**
 * The most input bytes that may wait for room in a window. `input()` is not only the keyboard:
 * xterm answers the AGENT's escape sequences through it, and nothing rate-limits that producer.
 */
export const MAX_PENDING_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * The heartbeat interval assumed until the server states its own, and how many of them of silence
 * mean the socket is gone. Timed against the server's ping: an idle agent says nothing for minutes.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_GRACE_INTERVALS = 2;

/**
 * The range a stated interval must fall in to be believed: `intervalMs` is the one wire value used
 * as a control parameter, and an absurd one arms a bound every replacement socket then re-arms.
 */
export const MIN_HEARTBEAT_INTERVAL_MS = 100;
// A small multiple of the default rather than a generous ceiling: the stated interval sets the
// silence bound, so a large in-range value delays noticing a dead socket by the grace multiplier too.
export const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How many sockets in a row may carry nothing before the client says why, once. It does NOT stop
 * the ladder: this is an inference from two things agreeing, not a verdict from the server.
 */
export const SILENT_ATTEMPTS_BEFORE_DIAGNOSIS = 3;

/**
 * How long the token probe may take before the ladder stops waiting. `fetch` has no timeout and an
 * iOS request issued as the tab backgrounds may never settle, which strands the whole ladder.
 */
export const TOKEN_PROBE_TIMEOUT_MS = 10_000;

/** The stated interval if it is usable, the default otherwise. */
const usableHeartbeatInterval = (stated: unknown): number =>
  typeof stated === "number" &&
  Number.isFinite(stated) &&
  stated >= MIN_HEARTBEAT_INTERVAL_MS &&
  stated <= MAX_HEARTBEAT_INTERVAL_MS
    ? stated
    : DEFAULT_HEARTBEAT_INTERVAL_MS;

const encoder = new TextEncoder();

/** One queued piece of input, with the serialised size it will cost. */
interface PendingInput {
  sessionId: string;
  data: string;
  /** Bytes this piece adds to a frame's `data` field, excluding the surrounding quotes. */
  cost: number;
}

export interface ConnectionDeps {
  token: string;
  connect: SocketFactory;
  /**
   * Why this client cannot get in, as one cheap authenticated request. A browser never sees the
   * status of a rejected upgrade, so 401 and 403 are told apart over HTTP where the code survives.
   */
  verifyToken: () => Promise<TokenVerdict>;
  schedule?: (run: () => void, delayMs: number) => Cancel;
  /**
   * The reconnect ladder's jitter source, injected only so a test can pin it. The jitter keeps N
   * clients woken by one stalled server from walking the ladder in lockstep - see backoff.ts.
   */
  random?: () => number;
}

export interface ConnectionEvents {
  /** What to do with this session's terminal. Already resolved against the tracked position. */
  render: (sessionId: string, action: Extract<RenderAction, { kind: "repaint" | "write" }>) => void;
  state: (sessionId: string, state: SessionState, exitCode: number | undefined) => void;
  sessions: (sessions: Session[]) => void;
  /**
   * The width the panes are actually wrapped to, as the server states it on connect. From the wire
   * rather than this bundle's `PANE_COLS`: the two are built and restarted separately.
   */
  paneCols: (cols: number) => void;
  /** A sentence written by the server, rendered verbatim - rewording it loses its advice. */
  error: (sessionId: string | undefined, message: string) => void;
  status: (status: ConnectionStatus) => void;
  /** The token was rejected. Drop what is stored and show the paste field. */
  unauthorized: () => void;
}

export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "rejected"
  /** The server refused this page's origin. Not retried, and not the token's fault. */
  | "forbidden"
  | "closed";

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
  #policy: ReconnectPolicy;
  #socket: SocketLike | undefined;
  #opened = false;
  /**
   * Whether the CURRENT socket has delivered a frame. One that completed the handshake and said
   * nothing proves nothing: the 101 is answered by whatever sits in front of the server.
   */
  #carried = false;
  /** Whether the silent-socket diagnosis has already been said for this run of silence. */
  #diagnosed = false;
  #stopped = false;
  #cancelRetry: Cancel | undefined;
  #attachments = new Map<string, Attachment>();
  #status: ConnectionStatus = "closed";
  /** Pieces of input waiting for room in the window, oldest first. */
  #pendingInput: PendingInput[] = [];
  #pendingBytes = 0;
  /**
   * Which SESSIONS have had part of their queued input released while more is queued. Per session:
   * a Set of per-call ids grew by ~300k a second under the `\e[6n` loop the byte bound exists for.
   */
  #partiallyReleased = new Set<string>();
  #overflowed = false;
  #framesThisWindow = 0;
  #cancelWindow: Cancel | undefined;
  // Reset per socket: a value one socket stated about one server's timer says nothing about the
  // next, and it governs the window BEFORE that socket's first frame.
  #heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  /** True while `#onClosed` is waiting on the token probe, when there is no socket but a ladder. */
  #probing = false;
  #cancelSilence: Cancel | undefined;
  /** The bound on the probe currently out, so teardown does not leave a timer behind it. */
  #cancelProbe: Cancel | undefined;
  /** Drop the current socket as if it had closed. Undefined when there is no socket to drop. */
  #dropSocket: (() => void) | undefined;

  constructor(deps: ConnectionDeps, events: ConnectionEvents) {
    this.#deps = deps;
    this.#events = events;
    this.#schedule = deps.schedule ?? defaultSchedule;
    this.#policy = new ReconnectPolicy(deps.random);
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
    // A probe may be out; nothing will act on its answer, and its bound must not outlive this.
    // The request cannot be recalled, which is why `#onClosed` re-checks `#stopped` after it.
    this.#cancelProbe?.();
    this.#cancelProbe = undefined;
    this.#stopWatchingSilence();
    this.#dropSocket = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#resetInputWindow(false);
    this.#setStatus("closed");
  }

  /**
   * Attach, or re-declare an existing attachment's size. The set is kept across reconnects: it is
   * exactly the list of tabs to re-attach on the next open, each with the epoch and seq it got to.
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
   * Raw bytes the user typed, cut into as many `input` frames as the receiver's cap needs and
   * released in order. Nothing is rendered: the pty echoes, and the agent may transform or refuse it.
   */
  input(sessionId: string, data: string): void {
    let rest = data;
    while (rest.length > 0) {
      const cut = this.#cut(sessionId, rest);
      this.#queueInput(sessionId, rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    this.#flushInput();
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

  /** The bytes an `input` frame costs before any `data`: the envelope and the empty string. */
  #envelopeBytes(sessionId: string): number {
    return encoder.encode(JSON.stringify({ t: "input", sessionId, data: "" })).length;
  }

  #queueInput(sessionId: string, data: string): void {
    // Input typed with no socket at all is DROPPED rather than held: a reconnect is an untimed token
    // probe plus a backoff, so what was typed at a frozen pane would land in a different screen.
    if (this.#socket === undefined) {
      if (!this.#overflowed) {
        this.#overflowed = true;
        this.#events.error(
          sessionId,
          "you are not connected, so what you just typed was not sent - it is dropped rather than delivered later into whatever the agent is doing by then",
        );
      }
      return;
    }
    // JSON escaping is per character, so the cost of a joined string is the sum of the parts'
    // costs - and `#cut` never ends a piece on a lone high surrogate, so no pair is escaped twice.
    const cost = encoder.encode(JSON.stringify(data)).length - 2;
    if (this.#pendingBytes + cost > MAX_PENDING_INPUT_BYTES) {
      // Only ever the agent's own terminal replies or a paste far past what a person makes. Said
      // once per overflow, because the loop that caused it will hit this line thousands of times.
      if (!this.#overflowed) {
        this.#overflowed = true;
        this.#events.error(
          sessionId,
          "input is arriving faster than it can be sent and some of it has been dropped - if the agent is printing escape sequences in a loop, interrupt it",
        );
      }
      return;
    }
    this.#pendingBytes += cost;
    this.#pendingInput.push({ sessionId, data, cost });
  }

  /** Whether a frame handed to the socket now would actually reach the server. */
  #canSend(): boolean {
    // `#socket` is assigned before the socket is OPEN, and `browserSocket.send` silently discards
    // anything written while CONNECTING - draining into that window destroys the head of a paste.
    return this.#socket !== undefined && this.#opened;
  }

  #flushInput(): void {
    if (!this.#canSend()) return;
    while (this.#pendingInput.length > 0 && this.#framesThisWindow < MAX_INPUT_FRAMES_PER_WINDOW) {
      if (this.#framesThisWindow === 0) {
        this.#cancelWindow = this.#schedule(() => {
          this.#cancelWindow = undefined;
          this.#framesThisWindow = 0;
          this.#flushInput();
        }, INPUT_WINDOW_MS);
      }
      this.#framesThisWindow += 1;
      const frame = this.#takeFrame();
      this.#socket?.send(
        JSON.stringify({ t: "input", sessionId: frame.sessionId, data: frame.data }),
      );
      // Only interesting while more of that session's input is still waiting: that is exactly the
      // half-applied case the reset below warns about.
      if (this.#pendingInput.some((entry) => entry.sessionId === frame.sessionId)) {
        this.#partiallyReleased.add(frame.sessionId);
      }
    }
    if (this.#pendingInput.length === 0) {
      this.#partiallyReleased.clear();
      // Once per overflow rather than once per socket: a queue that drains and overflows again an
      // hour later would otherwise drop input silently, leaving the pty a hole that then resumes.
      this.#overflowed = false;
    }
  }

  /**
   * The next frame: as many consecutive pieces for one session as fit. The budget is one frame per
   * slot however few bytes it carries, and 200k eight-byte replies would hold the queue for hours.
   */
  #takeFrame(): PendingInput {
    const head = this.#pendingInput.shift() as PendingInput;
    this.#pendingBytes -= head.cost;
    const room = MAX_INPUT_FRAME_BYTES - this.#envelopeBytes(head.sessionId);
    let used = head.cost;
    const parts = [head.data];
    while (this.#pendingInput.length > 0) {
      const next = this.#pendingInput[0] as PendingInput;
      if (next.sessionId !== head.sessionId || used + next.cost > room) break;
      this.#pendingInput.shift();
      this.#pendingBytes -= next.cost;
      used += next.cost;
      parts.push(next.data);
    }
    head.data = parts.join("");
    return head;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const attachment = this.#attachments.get(sessionId);
    if (attachment === undefined) return;
    attachment.cols = cols;
    attachment.rows = rows;
    this.#send({ t: "resize", sessionId, cols, rows });
  }

  /**
   * Try again now, without waiting out the backoff - for a tab coming to the foreground or a
   * network returning. A delay scheduled while the phone was in a pocket is latency for nothing.
   */
  poke(): void {
    // `#probing`, not just `#socket`: `#onClosed` clears the socket before awaiting the probe, and a
    // wake in that window opened a second socket. `forbidden` stops the ladder but not the tab.
    if (this.#stopped && this.#status === "forbidden") this.#stopped = false;
    if (this.#stopped || this.#socket !== undefined || this.#probing) return;
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
    this.#open(this.#resumeStatus());
  }

  /**
   * The status a re-open shows: whatever the ladder already shows, or `connecting`. Taking the
   * reconnecting banner down and putting it back says something changed when nothing has.
   */
  #resumeStatus(): ConnectionStatus {
    return this.#status === "reconnecting" ? "reconnecting" : "connecting";
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#events.status(status);
  }

  /**
   * Restart the silence bound, for every frame of any type. A half-open socket is closed at neither
   * end, so this timer is the only thing that can notice it went away.
   */
  #noteTraffic(): void {
    this.#cancelSilence?.();
    // The range check is applied here too, not only where the interval is stored, so no path can
    // arm a bound that expires before a healthy server could possibly have spoken again.
    this.#cancelSilence = this.#schedule(
      () => {
        this.#cancelSilence = undefined;
        this.#dropSocket?.();
      },
      usableHeartbeatInterval(this.#heartbeatIntervalMs) * HEARTBEAT_GRACE_INTERVALS,
    );
  }

  #stopWatchingSilence(): void {
    this.#cancelSilence?.();
    this.#cancelSilence = undefined;
  }

  #open(status: ConnectionStatus): void {
    // Never leave a live socket behind: assigning over `#socket` orphaned one that was still
    // delivering frames and still holding a `closed` handler that would run the ladder again.
    this.#dropSocket?.();
    // AFTER the drop: dropping a socket that carried frames runs the ladder synchronously and ends
    // by scheduling a retry, which would then fire beside the socket opened below and drop it.
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
    this.#opened = false;
    this.#carried = false;
    this.#heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#setStatus(status);
    // One socket's close is handled once: the watchdog and the socket's own callback can both fire,
    // and running the ladder twice schedules two reconnects racing for one connection.
    let handled = false;
    const finish = (): void => {
      if (handled) return;
      handled = true;
      this.#stopWatchingSilence();
      this.#dropSocket = undefined;
      void this.#onClosed();
    };
    // A socket that cannot be CONSTRUCTED is a closed socket rather than a throw out of a timer
    // callback. Swallowed, not shown: the message quotes the subprotocol list, where the token is.
    let socket: SocketLike;
    try {
      socket = this.#deps.connect(this.#deps.token, {
        opened: () => {
          // A finished socket is inert: `close()` only starts the handshake, so one the watchdog
          // gave up on can still deliver buffered frames onto a Connection that has moved on.
          if (handled) return;
          this.#opened = true;
          this.#setStatus("open");
          this.#noteTraffic();
          // Re-attach every tab with where it got to: chunks if the epoch matches and the buffer
          // still covers it, a snapshot otherwise - which is the common case after a sleep.
          for (const sessionId of this.#attachments.keys()) this.#sendAttach(sessionId);
          // Anything typed during the CONNECTING window is still queued rather than destroyed.
          this.#flushInput();
        },
        message: (raw) => {
          if (handled) return;
          if (!this.#carried) {
            this.#carried = true;
            this.#policy.opened();
            // A frame arrived, so whatever the diagnosis below described is over. Said again if it
            // comes back, because by then it is a new outage rather than the same one repeating.
            this.#diagnosed = false;
          }
          this.#noteTraffic();
          this.#receive(raw);
        },
        closed: finish,
      });
    } catch {
      finish();
      return;
    }
    this.#socket = socket;
    this.#dropSocket = () => {
      socket.close();
      finish();
    };
    // Armed here rather than in `opened`: a socket stuck in CONNECTING produces no close, no error
    // and no open, and `poke()` returns early while a socket exists.
    this.#noteTraffic();
  }

  /** A new socket starts a new budget, and nothing queued for the old one is still wanted. */
  #resetInputWindow(report: boolean): void {
    if (report) {
      // A paste cut into frames can be half applied, and silence looks exactly like one that never
      // started - so the user pastes again and the lines that already ran run twice.
      const cut = new Set<string>();
      for (const entry of this.#pendingInput) {
        if (this.#partiallyReleased.has(entry.sessionId)) cut.add(entry.sessionId);
      }
      for (const sessionId of cut) {
        this.#events.error(
          sessionId,
          "the connection dropped part-way through sending what you pasted, so only the beginning of it reached the terminal - check what ran before pasting again",
        );
      }
    }
    this.#pendingInput.length = 0;
    this.#pendingBytes = 0;
    this.#partiallyReleased.clear();
    this.#overflowed = false;
    this.#framesThisWindow = 0;
    this.#cancelWindow?.();
    this.#cancelWindow = undefined;
  }

  async #onClosed(): Promise<void> {
    this.#socket = undefined;
    this.#resetInputWindow(true);
    if (this.#stopped) return;

    // A socket that carried nothing may be a refusal wearing a network failure's clothes; one that
    // carried a frame cannot be. Traffic rather than the handshake, the boundary the ladder uses.
    if (!this.#carried) {
      this.#probing = true;
      let verdict: TokenVerdict;
      try {
        verdict = await this.#probe();
      } finally {
        this.#probing = false;
      }
      // The verdict describes a connection that may no longer exist, and `unauthorized()` is not a
      // notification: it clears the stored token, so a late 401 would wipe a freshly pasted one.
      if (this.#stopped) return;
      if (verdict === "rejected") {
        this.#policy.closed("token-rejected");
        this.#stopped = true;
        this.#setStatus("rejected");
        this.#events.unauthorized();
        return;
      }
      if (verdict === "forbidden") {
        // The token is good and the server is answering, so retrying is the one thing that cannot
        // help - this used to run the ladder forever over a configuration mistake.
        this.#policy.closed("origin-rejected");
        this.#stopped = true;
        this.#setStatus("forbidden");
        this.#events.error(
          undefined,
          "the server accepted your token and refused this page's address: it was started with AGENTDECK_ORIGIN set to a different address than the one you opened. Reconnecting cannot fix that - open the address the server expects, or restart it with AGENTDECK_ORIGIN matching this one.",
        );
        return;
      }
      // Only for `ok`. `unreachable` retries the same but means the opposite: the probe did not
      // answer either, so asserting a broken proxy would be a guess presented as a finding.
      if (verdict === "ok") this.#diagnoseSilence();
    }
    if (this.#stopped) return;

    const decision = this.#policy.closed("network");
    if (!decision.retry) return;
    if (decision.showReconnecting) this.#setStatus("reconnecting");
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = undefined;
      if (this.#stopped) return;
      this.#open(this.#resumeStatus());
    }, decision.delayMs);
  }

  /**
   * The probe's verdict, or `unreachable` if it does not produce one. A rejection is the same
   * answer as the timeout: the ladder cannot survive not getting a decision, and both mean silence.
   */
  async #probe(): Promise<TokenVerdict> {
    try {
      return await Promise.race([
        this.#deps.verifyToken().catch((): TokenVerdict => "unreachable"),
        new Promise<TokenVerdict>((resolve) => {
          this.#cancelProbe = this.#schedule(() => {
            this.#cancelProbe = undefined;
            resolve("unreachable");
          }, TOKEN_PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      this.#cancelProbe?.();
      this.#cancelProbe = undefined;
    }
  }

  /** Say, once, that the thing failing is the socket rather than the network or the token. */
  #diagnoseSilence(): void {
    if (this.#diagnosed) return;
    // `attempts` is retries since the last frame arrived, because `#policy.opened()` is called on
    // traffic rather than on the handshake. It is therefore already the count this wants.
    if (this.#policy.attempts < SILENT_ATTEMPTS_BEFORE_DIAGNOSIS) return;
    this.#diagnosed = true;
    this.#events.error(
      undefined,
      "the server is answering over HTTP and accepting this token, but the connection to it has now failed several times without carrying anything - so what is failing is the socket itself, not the network and not the token. Something in front of the server that does not pass WebSocket upgrades is the usual cause. Reconnecting will keep trying.",
    );
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
    // Dropped rather than queued while disconnected: everything the server needs is re-sent on open
    // from the attachment set, and a queued keystroke lands in whatever the agent is doing by then.
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
      case "hello":
        // Through the same range check `intervalMs` gets, and for the same reason: it is a wire
        // value the terminal is resized by, not data handed to it.
        this.#events.paneCols(usablePaneCols(message.cols));
        return;
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
      case "ping":
        // Nothing is sent back: the frame arriving is the proof of life, and a reply would spend
        // part of an idle tab's input budget on saying nothing.
        this.#heartbeatIntervalMs = usableHeartbeatInterval(message.intervalMs);
        // Re-armed, because the bound set moments ago was measured against the previous interval.
        this.#noteTraffic();
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
