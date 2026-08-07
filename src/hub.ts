import { SessionPty } from "./pty.ts";
import type { Registry } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import type { Tmux } from "./tmux.ts";

// Owns one live attachment per session, and keeps that set equal to what tmux actually has.
//
// The reconciliation is deliberately one-directional: tmux is the truth, and this catches up.
// A hub that remembered its own set of sessions would be a second source that has to keep
// agreeing with the first, and the interesting cases - a session created by a human in a
// terminal, a session whose agent exited while nobody was looking - are exactly the ones a
// remembered set gets wrong.

/** Size a session's pane opens at before any browser client has said what it wants. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// A repaint is finished when tmux stops writing, and tmux does not say so. There is no marker in
// the stream and nothing to synchronise on: `refresh-client` returns as soon as the redraw is
// queued, not when the client has received it. So the end of the repaint is the quiet after it,
// with a cap for the case where the pane is drawing on its own at the same time - a snapshot that
// waits for an animated spinner to stop waits forever.
const REPAINT_QUIET_MS = 120;
const REPAINT_MAX_MS = 1000;

export interface HubOptions {
  tmux: Tmux;
  registry: Registry;
  socket: string;
  /** Injected for tests: builds the live attachment for a session. */
  createPty?: (sessionId: string) => SessionPty;
  /** Injected so a test of the repaint does not have to spend a real second on it. */
  repaintQuietMs?: number;
  repaintMaxMs?: number;
}

export class Hub {
  #tmux: Tmux;
  #registry: Registry;
  #socket: string;
  #createPty: (sessionId: string) => SessionPty;
  #ptys = new Map<string, SessionPty>();
  #repaintQuietMs: number;
  #repaintMaxMs: number;

  constructor(options: HubOptions) {
    this.#tmux = options.tmux;
    this.#registry = options.registry;
    this.#socket = options.socket;
    this.#repaintQuietMs = options.repaintQuietMs ?? REPAINT_QUIET_MS;
    this.#repaintMaxMs = options.repaintMaxMs ?? REPAINT_MAX_MS;
    this.#createPty =
      options.createPty ??
      ((sessionId) =>
        new SessionPty({
          socket: this.#socket,
          sessionId,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        }));
  }

  /**
   * Attach to every ALLOWED session tmux has, and let go of everything else.
   *
   * Called at start and after any change to the session list. Cheap enough to call often.
   *
   * "Allowed" is not decided here. `Registry.list` applies the cwd allowlist, and it is the only
   * place that does: a boundary two callers apply separately is one that can be applied
   * differently. What that filter keeps out is a session whose directory - the one TMUX reports,
   * not one remembered here - is not on the allowlist: `/tmp/tmux-<uid>/agentdeck` is writable by
   * every process running as this user, so `tmux -L agentdeck new-session -d -c / -- /bin/sh`
   * would otherwise become a tab within one sync interval, streamed to the phone and accepting
   * typed input, having asked nobody. It is a filter on WHERE a session is, not a claim that
   * agentdeck started it - a same-uid process owns the socket either way.
   *
   * The cost, accepted deliberately and written into plan 005 rather than left implicit: a
   * session started by hand in tmux does not appear as a tab. Neither does one this server
   * created before a restart, because the cwd it is matched on lives in the registry's memory and
   * a restart takes it - the same loss `CwdAllowlist.refusal` already warns a restart costs, one
   * step further. Recreating the session recovers it.
   */
  async sync(): Promise<void> {
    const live = await this.#registry.list();
    const liveIds = new Set(live.map((session) => session.id));

    for (const session of live) {
      // A session that has already exited gets no PTY: attaching to a dead pane would produce a
      // stream that never carries anything, and the exit code is already on the list.
      if (session.state === "exited") continue;
      if (!this.#ptys.has(session.id)) {
        try {
          this.#ptys.set(session.id, this.#createPty(session.id));
        } catch (error) {
          // One session that cannot be attached must not take down the server, which is what
          // happened the first time this ran for real: a node-pty spawn threw, nothing caught it,
          // and every OTHER session died with the process. The tab for this one shows whatever
          // the list says and carries no stream, which is a worse tab rather than a lost server.
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

    // Push inferred state back so GET /api/sessions reports what the stream observed rather than
    // a default. This is the field the tab UI exists to show.
    for (const [id, pty] of this.#ptys) {
      this.#registry.setState(id, pty.stream.state());
    }
  }

  streamFor(sessionId: string): SessionStream | undefined {
    return this.#ptys.get(sessionId)?.stream;
  }

  sendInput(sessionId: string, data: string): void {
    this.#ptys.get(sessionId)?.write(data);
  }

  applyPaneSize(sessionId: string, cols: number, rows: number): void {
    this.#ptys.get(sessionId)?.resize(cols, rows);
  }

  async captureHistory(sessionId: string, lines: number): Promise<string> {
    return await this.#tmux.captureHistory(sessionId, lines);
  }

  async isAlternateScreen(sessionId: string): Promise<boolean> {
    return await this.#tmux.isAlternateScreen(sessionId);
  }

  /**
   * Ask tmux to repaint, and collect the bytes it repaints with.
   *
   * The collection is the point. `refresh-client -R` writes into the PTY this hub is already
   * reading, so the repaint arrives as ordinary output on the session's stream - which is what
   * makes its `seq` answerable at all. Reading it back off the stream rather than out of the ring
   * buffer is what separates the live screen from whatever output happened to be recent.
   *
   * Any output the agent produces during the window comes with it. That is correct: those bytes
   * are in the stream too, and the seq returned is the count after all of them, so a client that
   * discards chunks at or below it neither loses nor doubles anything.
   *
   * The collection stops at a byte budget as well as at the quiet and the cap. A pane that writes
   * without pause - an agent looping on stdout, deliberately or not - delivers tens of megabytes
   * inside the 1000ms cap, and every copy the snapshot then makes (the parts, the concat, the
   * string, the JSON escape) is that size again, on a process nothing restarts. The budget is the
   * ring buffer's capacity, which is the bound the rest of the protocol already lives inside.
   * Truncating costs nothing: `seq` is the seq of the last chunk actually included, so the bytes
   * left behind reach the client as ordinary chunks with a greater seq, in order.
   */
  async repaint(sessionId: string): Promise<{ data: string; seq: number }> {
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
    const cap = setTimeout(finish, this.#repaintMaxMs);
    try {
      await this.#tmux.repaint(sessionId);
      await settled;
    } finally {
      off();
      if (quiet !== undefined) clearTimeout(quiet);
      clearTimeout(cap);
    }
    // No bytes at all is a failed repaint, not an empty screen. A snapshot is authoritative - the
    // client clears the terminal and writes what it is given - so shipping "" paints a live
    // session blank. Fail instead, and let the caller answer with an error the client retries.
    if (parts.length === 0)
      throw new Error(`no repaint arrived for ${sessionId} within ${this.#repaintMaxMs}ms`);
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
