import { modeBytes } from "./pane-modes.ts";
import { PANE_COLS } from "./protocol.ts";
import { SessionPty } from "./pty.ts";
import type { Registry } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import type { SessionState, Tmux } from "./tmux.ts";

// Owns one live attachment per session, and keeps that set equal to what tmux has. One-directional
// on purpose: a remembered set gets exactly the interesting cases wrong.

/**
 * Rows a pane opens at before any client says what it wants: a guess, superseded the moment one
 * reports. Unlike the width, being wrong costs nothing - tmux reflows height freely.
 */
const DEFAULT_ROWS = 30;

// A repaint is finished when tmux stops writing, and tmux does not say so - `refresh-client`
// returns when the redraw is queued. So: the quiet after it, capped, or a spinner waits forever.
const REPAINT_QUIET_MS = 120;
const REPAINT_MAX_MS = 1000;

/** What the hub calls when a session's state is news. `src/server.ts` wires this to the sockets. */
export type StateListener = (sessionId: string, state: SessionState, exitCode?: number) => void;

export interface HubOptions {
  tmux: Tmux;
  registry: Registry;
  socket: string;
  /** Injected for tests: builds the live attachment for a session. */
  createPty?: (sessionId: string) => SessionPty;
  /** Injected so a test of the repaint does not have to spend a real second on it. */
  repaintQuietMs?: number;
  repaintMaxMs?: number;
  /**
   * Called when a session's state CHANGES, so the strip is told rather than asked (plan 002).
   * Without it the only state frame a client sees is the one answering its own `attach`.
   */
  onState?: StateListener;
}

export class Hub {
  #tmux: Tmux;
  #registry: Registry;
  #socket: string;
  #createPty: (sessionId: string) => SessionPty;
  #ptys = new Map<string, SessionPty>();
  #repaintQuietMs: number;
  #repaintMaxMs: number;
  #onState: StateListener | undefined;
  /**
   * The last state each live session was announced with, so a repeat is not sent. The exit code is
   * part of the key: `exited` then `exited 137` is news, and state alone suppressed it forever.
   */
  #announced = new Map<string, { state: SessionState; exitCode: number | undefined }>();

  constructor(options: HubOptions) {
    this.#tmux = options.tmux;
    this.#registry = options.registry;
    this.#socket = options.socket;
    this.#onState = options.onState;
    this.#repaintQuietMs = options.repaintQuietMs ?? REPAINT_QUIET_MS;
    this.#repaintMaxMs = options.repaintMaxMs ?? REPAINT_MAX_MS;
    this.#createPty =
      options.createPty ??
      ((sessionId) =>
        new SessionPty({
          socket: this.#socket,
          sessionId,
          cols: PANE_COLS,
          rows: DEFAULT_ROWS,
        }));
  }

  /**
   * Attach to every ALLOWED session tmux has, and let go of the rest. "Allowed" is decided by
   * `Registry.list` alone; kept out is a session whose NAME is not `sessionId(its allowlisted path, a configured agent)`.
   */
  async sync(): Promise<void> {
    const live = await this.#registry.list();
    const liveIds = new Set(live.map((session) => session.id));

    for (const session of live) {
      // A session that has already exited gets no PTY: attaching to a dead pane would produce a
      // stream that never carries anything, and the exit code is already on the list.
      if (session.state === "exited") continue;
      // Our ATTACH CLIENT dying is not the AGENT dying: `detach-client` leaves the pane running
      // while the stream sticks at `exited`. tmux's list is the authority, so drop and re-attach.
      const existing = this.#ptys.get(session.id);
      if (existing !== undefined && existing.stream.state() === "exited") {
        existing.dispose();
        this.#ptys.delete(session.id);
      }
      if (!this.#ptys.has(session.id)) {
        try {
          this.#ptys.set(session.id, this.#createPty(session.id));
        } catch (error) {
          // One session that cannot be attached must not take down the server: this tab carries no
          // stream, which is a worse tab rather than every other session dying with the process.
          console.error(`agentdeck: could not attach to ${session.id}:`, error);
        }
      }
    }

    for (const [id, pty] of this.#ptys) {
      if (!liveIds.has(id)) {
        pty.dispose();
        this.#ptys.delete(id);
      }
    }

    // Push inferred state back so the session list reports what the stream observed. A session with
    // no attachment is announced with what the registry says, the only reading there is.
    for (const session of live) {
      // tmux says the pane is dead, so the stream gets no vote: with `remain-on-exit on` the attach
      // client outlives it and still reads `idle`, which used to be announced over `exited 137`.
      if (session.state === "exited") {
        this.#ptys.get(session.id)?.stream.declare("exited", session.exitCode);
        this.announce(session.id, session.state, session.exitCode);
        continue;
      }
      const stream = this.#ptys.get(session.id)?.stream;
      if (stream !== undefined) this.#registry.setState(session.id, stream.state());
      this.announce(session.id, stream?.state() ?? session.state, session.exitCode);
    }
    for (const id of this.#announced.keys()) {
      if (!liveIds.has(id)) this.#announced.delete(id);
    }
  }

  /** Whether this hub currently holds a stream for a session, which only `sync()` sets up. */
  attached(sessionId: string): boolean {
    return this.#ptys.has(sessionId);
  }

  /**
   * Say a session's state once, and only when it is news. The single funnel for both sources: this
   * sync's inference, and an agent's own hook, which is announced the moment it lands.
   */
  announce(sessionId: string, state: SessionState, exitCode?: number): void {
    const last = this.#announced.get(sessionId);
    if (last?.state === state && last.exitCode === exitCode) return;
    this.#announced.set(sessionId, { state, exitCode });
    this.#onState?.(sessionId, state, exitCode);
  }

  streamFor(sessionId: string): SessionStream | undefined {
    return this.#ptys.get(sessionId)?.stream;
  }

  sendInput(sessionId: string, data: string): void {
    this.#ptys.get(sessionId)?.write(data);
  }

  /** Rows follow the client; the width never moves, so history is only ever wrapped once. */
  applyPaneRows(sessionId: string, rows: number): void {
    this.#ptys.get(sessionId)?.resize(PANE_COLS, rows);
  }

  async captureHistory(sessionId: string, lines: number): Promise<string> {
    return await this.#tmux.captureHistory(sessionId, lines);
  }

  /** The pane's modes as the bytes that set them, for a snapshot to restate. */
  async paneModes(sessionId: string): Promise<string> {
    return modeBytes(await this.#tmux.paneModes(sessionId));
  }

  async isAlternateScreen(sessionId: string): Promise<boolean> {
    return await this.#tmux.isAlternateScreen(sessionId);
  }

  // One repaint per session at a time; callers arriving mid-flight share the result. `resync`
  // reaches this path unattached, so a looping client would multiply capture-panes without it.
  #repaints = new Map<string, Promise<{ data: string; seq: number }>>();

  /**
   * Ask tmux to repaint and collect the bytes it repaints with, off the stream rather than the ring
   * buffer - that is what separates the live screen from whatever output happened to be recent.
   */
  async repaint(sessionId: string): Promise<{ data: string; seq: number }> {
    const inFlight = this.#repaints.get(sessionId);
    if (inFlight !== undefined) return await inFlight;
    const started = this.#repaintOnce(sessionId).finally(() => {
      this.#repaints.delete(sessionId);
    });
    this.#repaints.set(sessionId, started);
    return await started;
  }

  async #repaintOnce(sessionId: string): Promise<{ data: string; seq: number }> {
    const stream = this.#ptys.get(sessionId)?.stream;
    if (stream === undefined) throw new Error(`no session ${sessionId} to repaint`);

    const parts: Buffer[] = [];
    let seq = stream.buffer.headSeq;
    let quiet: NodeJS.Timeout | undefined;
    let finish = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const budget = stream.buffer.capacity;
    let collected = 0;
    const off = stream.onChunk((chunk) => {
      if (collected >= budget) return;
      parts.push(chunk.data);
      collected += chunk.data.length;
      seq = chunk.seq;
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = setTimeout(finish, this.#repaintQuietMs);
      if (collected >= budget) finish();
    });
    // Started AFTER the tmux calls, so the cap measures how long the bytes take rather than the
    // spawns: `Tmux.repaint` refreshes every attached client, and an agent can attach many.
    let cap: NodeJS.Timeout | undefined;
    try {
      await this.#tmux.repaint(sessionId);
      cap = setTimeout(finish, this.#repaintMaxMs);
      await settled;
    } finally {
      off();
      if (quiet !== undefined) clearTimeout(quiet);
      if (cap !== undefined) clearTimeout(cap);
    }
    // No bytes is a failed repaint rather than an empty screen, and a snapshot is authoritative -
    // shipping "" paints a live session blank. Degrade to the buffer: stale beats nothing.
    if (parts.length === 0) {
      const held = stream.buffer.snapshot();
      // Nothing collected AND nothing buffered really is no screen. That case still fails.
      if (held.length === 0) {
        throw new Error(`no repaint arrived for ${sessionId} within ${this.#repaintMaxMs}ms`);
      }
      console.error(
        `agentdeck: no repaint arrived for ${sessionId} within ${String(this.#repaintMaxMs)}ms; ` +
          `falling back to the buffer, so this snapshot may be stale`,
      );
      return { data: held.toString("utf8"), seq: stream.buffer.headSeq };
    }
    return { data: Buffer.concat(parts).toString("utf8"), seq };
  }

  /** Detach from everything. The agents keep running; only our attachments go. */
  disposeAll(): void {
    for (const pty of this.#ptys.values()) pty.dispose();
    this.#ptys.clear();
  }

  get size(): number {
    return this.#ptys.size;
  }
}
