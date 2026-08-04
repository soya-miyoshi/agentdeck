import type { IPty } from "node-pty";
import { spawn } from "node-pty";

import { SessionStream } from "./stream.ts";

// The producer the stream has been waiting for: a PTY running `tmux attach`.
//
// The server attaches to every session for the session's lifetime, not per attached browser
// client (plan 001). Two things force it: `state` is on the session LIST, so the strip can say
// which agent needs you without opening N streams, and output cadence is a property of the byte
// stream - something has to read it whether or not a phone is looking, or an unwatched session
// has no status at all. That is the session most likely to be the one that needs you.
//
// This spawns `attach` rather than `new-session`. Creating the session is the registry's job and
// has already happened by the time we get here; conflating the two would mean the thing that
// reads output also decides what runs, and a reattach after a crash would try to create.

export interface PtyOptions {
  socket: string;
  sessionId: string;
  cols: number;
  rows: number;
  /** Injected so tests can drive the plumbing without a real tmux. */
  spawnPty?: (file: string, args: string[], options: { cols: number; rows: number }) => IPty;
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
    // `-d` detaches any other client from the session. Without it, a second attach makes tmux
    // size the pane to the smallest of ALL its clients, including the stale ones we thought had
    // gone - which would quietly override the minimum-over-attached-browsers rule with tmux's
    // own arithmetic over a set we do not control.
    this.#pty = spawnFn(
      "tmux",
      ["-L", options.socket, "attach-session", "-d", "-t", options.sessionId],
      { cols: options.cols, rows: options.rows },
    );

    this.#pty.onData((data: string) => {
      // node-pty hands us a string it decoded as UTF-8. Re-encoding is lossless for valid input
      // and is what keeps `seq` a count of the bytes the socket will actually carry - the whole
      // definition depends on the counter agreeing with what the client receives.
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
