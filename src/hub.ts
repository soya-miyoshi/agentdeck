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

export interface HubOptions {
  tmux: Tmux;
  registry: Registry;
  socket: string;
  /** Injected for tests: builds the live attachment for a session. */
  createPty?: (sessionId: string) => SessionPty;
}

export class Hub {
  #tmux: Tmux;
  #registry: Registry;
  #socket: string;
  #createPty: (sessionId: string) => SessionPty;
  #ptys = new Map<string, SessionPty>();

  constructor(options: HubOptions) {
    this.#tmux = options.tmux;
    this.#registry = options.registry;
    this.#socket = options.socket;
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

  /** Detach from everything. The agents keep running; only our attachments go. */
  disposeAll(): void {
    for (const pty of this.#ptys.values()) pty.dispose();
    this.#ptys.clear();
  }

  get size(): number {
    return this.#ptys.size;
  }
}
