import type { IPty } from "node-pty";
import { spawn } from "node-pty";

import { SessionStream } from "./stream.ts";
import { baseEnv, exactTarget } from "./tmux.ts";

// The producer the stream waits on: a PTY running `tmux attach`, one per session (plan 001).
// Never `new-session` - creating is the registry's job, and a reattach must not try to create.

export interface PtyOptions {
  socket: string;
  sessionId: string;
  cols: number;
  rows: number;
  /** Injected so tests can drive the plumbing without a real tmux. */
  spawnPty?: (
    file: string,
    args: string[],
    options: { cols: number; rows: number; env: Record<string, string> },
  ) => IPty;
}

/** A session's live attachment: the PTY, the stream it feeds, and the way to type into it. */
export class SessionPty {
  readonly stream: SessionStream;
  readonly sessionId: string;

  #pty: IPty;
  #disposed = false;

  constructor(options: PtyOptions) {
    this.sessionId = options.sessionId;
    this.stream = new SessionStream({ sessionId: options.sessionId });

    const spawnFn = options.spawnPty ?? spawn;
    // `-d` detaches every other client: otherwise tmux sizes the pane to the smallest of ALL of
    // them, overriding the minimum-over-attached-browsers rule with a set we do not control.
    this.#pty = spawnFn(
      "tmux",
      ["-L", options.socket, "attach-session", "-d", "-t", exactTarget(options.sessionId)],
      // The same explicit environment every tmux invocation gets. A CLIENT is a way into a
      // session's environment via `update-environment`, so this is the belt to that braces.
      { cols: options.cols, rows: options.rows, env: baseEnv() },
    );

    this.#pty.onData((data: string) => {
      // node-pty hands back a string it decoded as UTF-8; re-encoding keeps `seq` a count of the
      // bytes the socket will actually carry, which is what the whole definition rests on.
      this.stream.write(Buffer.from(data, "utf8"));
    });

    this.#pty.onExit(({ exitCode }) => {
      // Definitive, and the only signal that needs no inference. Sticky in the stream, so bytes
      // still draining out of a dead pane cannot resurrect it as `working`.
      this.stream.declare("exited", exitCode);
    });
  }

  write(data: string): void {
    if (!this.#disposed) this.#pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.#disposed) return;
    try {
      this.#pty.resize(cols, rows);
    } catch {
      // node-pty throws if the process has gone. A resize racing a dying agent is ordinary, and
      // failing here would take down the socket that was about to report the exit.
    }
  }

  /** Detach from tmux without touching the session: the agent keeps running. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#pty.kill();
    } catch {
      // Already gone. Nothing to do, and nothing worth failing a shutdown over.
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }
}
