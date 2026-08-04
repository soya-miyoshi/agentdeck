import { randomBytes } from "node:crypto";

import { RingBuffer } from "./ring-buffer.ts";
import type { SessionState } from "./tmux.ts";

// One of these per session, for the session's lifetime - not per attached browser client.
//
// Two things force that, and neither is negotiable (plan 001):
//
//   `state` is on the session LIST, so the strip can say which agent needs you without opening N
//   streams. That is the entire point of the strip.
//
//   Output cadence is a property of the byte stream. Something has to be reading it whether or
//   not a phone is looking, or an unwatched session has no status at all - and that is the
//   session most likely to be the one that needs you.
//
// The cost, stated rather than discovered: memory is sessions * ring size, not attached tabs *
// ring size. Ten repos at 256 KB is 2.5 MB, which is not a consideration.

/** Bytes in a window count as `working`. One keystroke echoing back is not an agent thinking. */
export const WORKING_BYTE_THRESHOLD = 16;

/** How long output keeps a session `working` after the last byte. */
export const WORKING_LINGER_MS = 2000;

export interface StreamOptions {
  sessionId: string;
  capacity?: number;
  /** Injected so cadence can be tested without waiting for wall-clock time. */
  now?: () => number;
}

export interface Chunk {
  epoch: string;
  seq: number;
  data: Buffer;
}

export class SessionStream {
  readonly sessionId: string;
  readonly buffer: RingBuffer;

  #now: () => number;
  #lastOutputAt = 0;
  #bytesSinceQuiet = 0;

  // Set by a signal more reliable than cadence, and sticky until something contradicts it: an
  // agent's own turn boundary (plan 004's hook), or process exit. Cadence never overrides these,
  // because cadence is an inference and these are statements.
  #declared: SessionState | undefined;
  #exitCode: number | undefined;

  #listeners = new Set<(chunk: Chunk) => void>();
  #clients = new Map<string, { cols: number; rows: number }>();

  constructor(options: StreamOptions) {
    this.sessionId = options.sessionId;
    this.#now = options.now ?? Date.now;
    // A random epoch per process. Session ids deliberately survive a restart; this counter must
    // not appear to, or a client resuming with a stale seq is told it is covered and then paints
    // nothing forever while every other signal looks healthy.
    this.buffer = new RingBuffer(randomBytes(8).toString("hex"), options.capacity);
  }

  get epoch(): string {
    return this.buffer.epoch;
  }

  /** Output from the session. The only writer is whatever is reading the PTY. */
  write(data: Buffer): void {
    if (data.length === 0) return;

    const now = this.#now();
    if (now - this.#lastOutputAt > WORKING_LINGER_MS) this.#bytesSinceQuiet = 0;
    this.#bytesSinceQuiet += data.length;
    this.#lastOutputAt = now;

    // Output means the agent is doing something, which contradicts a declared `waiting`. It does
    // not contradict `exited`: a dead pane can still have bytes read out of it.
    if (this.#declared === "waiting") this.#declared = undefined;

    const seq = this.buffer.append(data);
    const chunk: Chunk = { epoch: this.epoch, seq, data };
    for (const listener of this.#listeners) listener(chunk);
  }

  /**
   * The state the session list reports.
   *
   * Signal order is the plans' order of reliability: process exit is definitive, the agent's own
   * statement about itself comes next, and cadence is the agent-agnostic fallback. An agent with
   * no mechanism still gets a useful tab; it simply never claims `waiting`. The design degrades
   * to fewer states, never to a wrong one - a strip that is confidently wrong is worse than one
   * that admits it does not know.
   */
  state(): SessionState {
    if (this.#declared === "exited") return "exited";
    if (this.#declared !== undefined) return this.#declared;

    const quietFor = this.#now() - this.#lastOutputAt;
    if (quietFor <= WORKING_LINGER_MS && this.#bytesSinceQuiet >= WORKING_BYTE_THRESHOLD) {
      return "working";
    }
    return "idle";
  }

  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  /** A statement rather than an inference: the agent's own hook, or the process exiting. */
  declare(state: SessionState, exitCode?: number): void {
    this.#declared = state;
    if (exitCode !== undefined) this.#exitCode = exitCode;
  }

  onChunk(listener: (chunk: Chunk) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  attach(clientId: string, cols: number, rows: number): void {
    this.#clients.set(clientId, { cols, rows });
  }

  detach(clientId: string): void {
    this.#clients.delete(clientId);
  }

  resize(clientId: string, cols: number, rows: number): void {
    // Only for a client that is actually attached: a resize from a detached client would
    // otherwise constrain a pane nobody is looking at through.
    if (this.#clients.has(clientId)) this.#clients.set(clientId, { cols, rows });
  }

  get clients(): ReadonlyMap<string, { cols: number; rows: number }> {
    return this.#clients;
  }

  get attachedCount(): number {
    return this.#clients.size;
  }
}
