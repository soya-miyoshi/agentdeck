import { SessionPty } from "./pty.ts";
import type { Registry } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import type { SessionState, Tmux } from "./tmux.ts";

// Owns one live attachment per session, and keeps that set equal to what tmux actually has.
//
// The reconciliation is deliberately one-directional: tmux is the truth, and this catches up.
// A hub that remembered its own set of sessions would be a second source that has to keep
// agreeing with the first, and the interesting cases - a session created by a human in a
// terminal, a session whose agent exited while nobody was looking - are exactly the ones a
// remembered set gets wrong.

/**
 * The width of every pane, for the whole life of every session. Not a default: a constant.
 *
 * tmux does not reflow scrollback. Whatever width the pane had when a line was written is frozen
 * into the history at that width, so a pane whose width follows the attached client leaves a
 * trail of differently-wrapped stretches behind it - and re-wrapping those at the phone's width
 * is what breaks older output mid-column, no matter what the phone reports. Sizing to the
 * viewport therefore cannot be made right; only never moving can. The client fixes itself at the
 * same 40 and scales its font to fit, so what it renders matches what the agent laid out.
 *
 * 40 is a portrait phone's worth of a legible monospace, and the phone is the only thing that
 * attaches.
 */
export const PANE_COLS = 40;

/**
 * Rows a pane opens at before any browser client has said what it wants.
 *
 * A guess - the remaining height over a ~15.6px line, once the tab strip and the key row have
 * taken theirs - and superseded the moment a real client reports what it measured. Unlike the
 * width, being wrong here costs nothing permanent: tmux reflows the screen's height freely.
 */
const DEFAULT_ROWS = 30;

// A repaint is finished when tmux stops writing, and tmux does not say so. There is no marker in
// the stream and nothing to synchronise on: `refresh-client` returns as soon as the redraw is
// queued, not when the client has received it. So the end of the repaint is the quiet after it,
// with a cap for the case where the pane is drawing on its own at the same time - a snapshot that
// waits for an animated spinner to stop waits forever.
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
   * Called when a session's state CHANGES, so the strip is told rather than asked.
   *
   * Plan 002: `state` is pushed, not polled. Without this the only state frame a client ever saw
   * was the one answering its own `attach`, so a tab that was not being looked at - or one whose
   * agent changed state after the attach - showed whatever the last full session list said, until
   * something else made the client fetch one. That is a poll waiting to be written.
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
   * The last state each live session was announced with, so a repeat is not sent.
   *
   * The exit code is part of the key, not a passenger: `exited` with no code followed by `exited
   * 137` is news - it is the difference between "it stopped" and "it was killed" - and a key of
   * state alone suppressed the second one forever.
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
   * The cost, accepted deliberately and written into plan 005 rather than left implicit: what is
   * kept out is a session whose NAME is not `sessionId(its allowlisted path, a configured agent)`
   * - not a session this server did not start. A hand-started session under a matching name is
   * listed, streamed and typed into; plan 002 records that residual.
   *
   * A session this server created BEFORE a restart does appear again, because `Registry.list`
   * adopts it from tmux (see `Registry.#adopt`) - allowlist-checked against `#{session_path}` like
   * everything else here, so this is the same boundary and not a way around it. Such a session is
   * streamed and typed into as normal; what it has lost is its hook secret, so it can never report
   * `waiting` again until its agent is restarted, and it carries `waitingDetectionLost` to say so.
   */
  async sync(): Promise<void> {
    const live = await this.#registry.list();
    const liveIds = new Set(live.map((session) => session.id));

    for (const session of live) {
      // A session that has already exited gets no PTY: attaching to a dead pane would produce a
      // stream that never carries anything, and the exit code is already on the list.
      if (session.state === "exited") continue;
      // Our ATTACH CLIENT dying is not the AGENT dying, and the two were indistinguishable. tmux
      // `detach-client` kills the client while the pane keeps running - and it is one keystroke
      // away for anyone with a real keyboard - after which `SessionPty.onExit` declares `exited`
      // on the stream, which is sticky, while the loop below leaves the dead pty in place because
      // the session is still in the live list. The result was a tab reporting a finished agent
      // that is still working, with every keystroke written into a dead pty and going nowhere, and
      // no recovery short of restarting the server. tmux still lists the session as alive, so the
      // list is the authority: drop the corpse and let the next line re-attach.
      const existing = this.#ptys.get(session.id);
      if (existing !== undefined && existing.stream.state() === "exited") {
        existing.dispose();
        this.#ptys.delete(session.id);
      }
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
    // a default. This is the field the tab UI exists to show - and telling the clients is the half
    // that makes the strip pushed rather than polled. A session with no attachment - one that has
    // exited - is announced with what the registry says, because that is the only reading of it
    // there is, and there is nothing inferred to write back for it.
    for (const session of live) {
      // tmux says the pane is dead, so the stream does not get a vote. With `remain-on-exit on`
      // the attach client stays alive against the dead pane, so `SessionPty.onExit` never fires
      // and the stream still reads `idle` two seconds after the last byte - which used to be
      // announced OVER the registry's correct `exited 137`, turning a killed agent into a
      // healthy-looking tab. Declaring it on the stream as well is what stops the `attach` reply
      // in src/ws.ts from answering `idle` for the same session.
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

  /**
   * Say a session's state once, and only when it is news.
   *
   * The single funnel for both sources: this sync's inference, and an agent's own hook statement
   * arriving over HTTP (src/http.ts), which is announced the moment it lands rather than at the
   * next sync - the difference between a transition seen in milliseconds and one seen in up to a
   * sync interval.
   */
  /** Whether this hub currently holds a stream for a session, which only `sync()` sets up. */
  attached(sessionId: string): boolean {
    return this.#ptys.has(sessionId);
  }

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
  // One repaint per session at a time. Every ws frame is handled fire-and-forget with no rate
  // limit, and `resync` reaches this path without the client being attached, so a client that
  // repeats itself - a loop, a bug, or a deliberate flood - otherwise multiplies into one
  // capture-pane plus one refresh-client per attached tmux client per request, each holding a
  // listener and up to the ring buffer's capacity for the length of its collection window.
  // Callers that arrive while one is in flight get that one's result.
  #repaints = new Map<string, Promise<{ data: string; seq: number }>>();

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
    // Started AFTER the tmux calls, so the budget measures how long the bytes take to arrive
    // rather than how long it took to spawn the clients. `Tmux.repaint` refreshes every client
    // attached to the session, sequentially, and an agent owns a shell on the same uid as the
    // socket - so it can attach enough clients that the spawns alone outlast any fixed cap.
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
    // No bytes at all is a failed repaint, not an empty screen: a snapshot is authoritative - the
    // client clears the terminal and writes what it is given - so shipping "" paints a live
    // session blank. Throwing was worse, because the failure can be permanent and induced: an
    // agent that attaches enough tmux clients makes every repaint miss its budget, and the tab
    // then shows NOTHING for every phone, for that session, while the session list and the state
    // field still look correct. Degrade to what the buffer holds, which is what this returned
    // before the repaint existed - a stale screen rather than no screen - and say so in the log.
    if (parts.length === 0) {
      const held = stream.buffer.snapshot();
      // Nothing collected AND nothing buffered really is no screen, and a blank authoritative
      // snapshot paints a live session empty. That case still fails.
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
