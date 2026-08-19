import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { buildSnapshot, planAttach } from "./attach.ts";
import { PANE_COLS, parseClientMessage, paneRows, type ServerMessage } from "./protocol.ts";
import type { Session } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import type { SessionState } from "./tmux.ts";
import { tokenMatches } from "./token.ts";

// One socket, multiplexed over every attached session. Not one per tab: phones background
// aggressively, and re-establishing N sockets on wake is N chances to fail.

/** Server pings this often; a client that has not ponged within twice this is closed. */
export const PING_INTERVAL_MS = 15_000;

// A phone that loses signal leaves a connection dead at both ends and closed at neither: nothing
// arrives, nothing errors, and the strip freezes at a status that is confidently wrong.
export const PONG_TIMEOUT_MS = PING_INTERVAL_MS * 2;

// One socket's frame budget per window: `resync` reaches capture-pane, and a client that
// reconnects on its own can loop unwatched. The rest of the window is dropped, not closed.
export const RATE_WINDOW_MS = 1000;
/** Frames one socket may send per window. Far above typing, far below a repaint loop. */
export const MAX_FRAMES_PER_WINDOW = 100;

// A frame budget bounds how MANY frames arrive, not how big they are. ws defaults maxPayload to
// 100 MiB, fully buffered before `message` fires; src/http.ts refuses a body over the same 64 KB.
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * How long a coalesced snapshot build may run before it is abandoned and evicted. Generous, because
 * cutting a working capture short costs the tab its history: this bounds the build that never ends.
 */
export const SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * How many other clients' failed snapshot builds one `attach` may wait out before building its own.
 * Each build is bounded, but a chain of N is not - the last caller would wait N x the timeout.
 */
export const MAX_INHERITED_SNAPSHOT_FAILURES = 2;

/**
 * How many bytes of live output one attaching client may hold while its snapshot is built. Past it
 * the queue is dropped and the client is caught up from the ring buffer, which is bounded already.
 */
export const MAX_QUEUED_ATTACH_BYTES = 4 * 1024 * 1024;

export interface WsDeps {
  token: string;
  origin: string | undefined;
  /** The live stream for a session, or undefined if there is no such session. */
  streamFor: (sessionId: string) => SessionStream | undefined;
  /** Scrollback for a cold snapshot. The depth belongs to whoever implements this. */
  captureHistory: (sessionId: string) => Promise<string>;
  /** Whether the pane is on the alternate screen, where there is no scrollback to show. */
  isAlternateScreen: (sessionId: string) => Promise<boolean>;
  /** The pane's terminal modes as the bytes that set them, since a repaint states none of them. */
  paneModes: (sessionId: string) => Promise<string>;
  /** The live screen for a cold snapshot, and the seq the bytes of it end at. */
  repaint: (sessionId: string) => Promise<{ data: string; seq: number }>;
  /**
   * The whole session list, sent the moment a socket opens. Without it a socket has no baseline:
   * the state dedupe is server-wide, so a transition announced while it was down is never repeated.
   */
  listSessions: () => Promise<Session[]>;
  /** Raw bytes the user typed, straight to the PTY. */
  sendInput: (sessionId: string, data: string) => void;
  /** Apply the minimum-over-attached-clients size. */
  applyPaneRows: (sessionId: string, rows: number) => void;
  /** How often to ping. Only the half-open test sets it, to a scale a suite can wait out. */
  pingIntervalMs?: number;
  /** How long a snapshot build may run. Only the hung-capture test sets it, for the same reason. */
  snapshotTimeoutMs?: number;
}

interface Client {
  id: string;
  socket: WebSocket;
  alive: boolean;
  /** Unsubscribe callbacks for every session this socket is attached to. */
  attached: Map<string, () => void>;
  windowStart: number;
  framesThisWindow: number;
  /** One sentence per window, not one per dropped frame. */
  toldAboutRate: boolean;
}

/**
 * How much one socket may have waiting to go out before it is treated as gone. A stalled phone
 * accepts frames into `bufferedAmount` forever; well above a snapshot, so slow is not dropped.
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    // Terminated rather than closed: `close()` is a handshake, and the reason this socket is over
    // the ceiling is that nothing it is sent is going anywhere. The client's ladder brings it back.
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(message));
};

export interface WsHandle {
  close: () => void;
  /**
   * Tell every open socket a session's state, attached to it or not. The strip must be able to say
   * "this one needs you" without attaching to every session, and there is no poll to fall back on.
   */
  pushState: (sessionId: string, state: SessionState, exitCode?: number) => void;
}

export const attachWebSocketServer = (server: Server, deps: WsDeps): WsHandle => {
  // noServer, so the upgrade is authenticated before any WebSocket exists: letting `ws` handle it
  // means a socket that opens and then closes, which a client cannot tell from a network problem.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let nextClientId = 0;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (code: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${String(code)} ${reason}\r\n\r\n`);
      socket.destroy();
    };

    if (deps.origin !== undefined && req.headers.origin !== undefined) {
      if (req.headers.origin !== deps.origin) return reject(403, "Forbidden");
    }

    // The token arrives as a subprotocol rather than in the URL: a URL lands in proxy logs,
    // browser history and referrer headers, and this token starts processes.
    const offered = (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const presented = offered.find((value) => value !== "agentdeck");
    if (presented === undefined || !tokenMatches(presented, deps.token)) {
      return reject(401, "Unauthorized");
    }

    // THE SERVER MUST ECHO THE SELECTED SUBPROTOCOL or the browser closes the connection, below
    // any code of ours - it presents as "the socket will not open" with nothing logged.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, presented);
    });
  });

  const clients = new Set<Client>();

  wss.on("connection", (socket: WebSocket) => {
    const client: Client = {
      id: `c${String(nextClientId++)}`,
      socket,
      alive: true,
      attached: new Map(),
      windowStart: Date.now(),
      framesThisWindow: 0,
      toldAboutRate: false,
    };
    clients.add(client);

    // FIRST: `ws` re-emits every receiver-level protocol violation as an `error` event, and an
    // EventEmitter with no `error` listener THROWS - one malformed frame took the whole server down.
    socket.on("error", (error: unknown) => {
      console.error("agentdeck: ws socket error:", error);
      // The close handler does the cleanup; this only makes sure a socket ws left open is not
      // still attached.
      socket.terminate();
    });
    socket.on("pong", () => {
      client.alive = true;
    });

    // The width this server's PTYs actually hold the panes at. The client's own `PANE_COLS` is
    // compiled into a bundle rebuilt separately, and the skew reads as padding rather than a bug.
    send(socket, { t: "hello", cols: PANE_COLS });

    // The baseline, before any frame this client sends; everything after it is a delta. A failure
    // costs this socket its resettle rather than its connection, so it is logged.
    deps
      .listSessions()
      .then((sessions) => {
        send(socket, { t: "sessions", sessions });
      })
      .catch((error: unknown) => {
        console.error("agentdeck: could not send the session list on connect:", error);
      });

    socket.on("message", (raw: Buffer) => {
      if (!withinRate(client)) return;
      // Fire-and-forget, so an unhandled rejection here would exit Node: handleMessage reaches
      // capture-pane, and a tmux failure must cost this message rather than every phone's socket.
      handleMessage(client, raw.toString("utf8")).catch((error: unknown) => {
        console.error("agentdeck: ws message failed:", error);
        send(client.socket, { t: "error", message: "that request failed; see the server log" });
      });
    });

    socket.on("close", () => {
      for (const [sessionId, off] of client.attached) {
        off();
        deps.streamFor(sessionId)?.detach(client.id);
        applySize(sessionId);
      }
      client.attached.clear();
      clients.delete(client);
    });
  });

  const withinRate = (client: Client): boolean => {
    const now = Date.now();
    if (now - client.windowStart >= RATE_WINDOW_MS) {
      client.windowStart = now;
      client.framesThisWindow = 0;
      client.toldAboutRate = false;
    }
    client.framesThisWindow += 1;
    if (client.framesThisWindow <= MAX_FRAMES_PER_WINDOW) return true;
    if (!client.toldAboutRate) {
      client.toldAboutRate = true;
      send(client.socket, {
        t: "error",
        message: `that tab sent more than ${String(MAX_FRAMES_PER_WINDOW)} messages in a second; the rest of this second was dropped`,
      });
    }
    return false;
  };

  const applySize = (sessionId: string): void => {
    const stream = deps.streamFor(sessionId);
    if (stream === undefined) return;
    const rows = paneRows(stream.clients.values());
    // undefined means nobody is attached, and the pane keeps the last size anyone asked for.
    // A client's cols never reach here - see PANE_COLS.
    if (rows !== undefined) deps.applyPaneRows(sessionId, rows);
  };

  const handleMessage = async (client: Client, raw: string): Promise<void> => {
    const parsed = parseClientMessage(raw);
    if ("error" in parsed) {
      send(client.socket, { t: "error", message: parsed.error });
      return;
    }
    const message = parsed.message;
    const stream = deps.streamFor(message.sessionId);
    if (stream === undefined) {
      send(client.socket, {
        t: "error",
        sessionId: message.sessionId,
        message: `no session ${message.sessionId}`,
      });
      return;
    }

    switch (message.t) {
      case "attach": {
        stream.attach(client.id, message.cols, message.rows);
        applySize(message.sessionId);
        // The listener must exist before the snapshot and must not SEND before it - a client with
        // no position answers a chunk with `resync` - so it queues, capped, and flushes after.
        let queued: { epoch: string; seq: number; data: Buffer }[] | undefined = [];
        let queuedBytes = 0;
        let dropped = false;
        const registeredHere = !client.attached.has(message.sessionId);
        if (registeredHere) {
          const off = stream.onChunk((chunk) => {
            if (queued !== undefined) {
              queuedBytes += chunk.data.length;
              if (queuedBytes > MAX_QUEUED_ATTACH_BYTES) {
                queued = [];
                queuedBytes = 0;
                dropped = true;
                return;
              }
              queued.push(chunk);
              return;
            }
            send(client.socket, {
              t: "chunk",
              sessionId: message.sessionId,
              epoch: chunk.epoch,
              seq: chunk.seq,
              data: chunk.data.toString("utf8"),
            });
          });
          client.attached.set(message.sessionId, off);
        }
        // The flush and the listener's fate are unconditional: a failed snapshot used to leave
        // `queued` an array forever, so the tab went silently blind for the life of the process.
        let at: number | undefined;
        let held: { epoch: string; seq: number; data: Buffer }[] = [];
        try {
          at = await sendPosition(
            client,
            message.sessionId,
            stream,
            message.haveEpoch,
            message.haveSeq,
          );
        } catch (error) {
          // Undo what THIS call set up and nothing else: tearing down an attachment that predates
          // it leaves an OPEN socket with no listener, and the client only re-attaches on reconnect.
          if (registeredHere) {
            client.attached.get(message.sessionId)?.();
            client.attached.delete(message.sessionId);
            stream.detach(client.id);
            applySize(message.sessionId);
          }
          throw error;
        } finally {
          held = queued ?? [];
          queued = undefined;
        }
        if (dropped) {
          // The queue was thrown away, so flushing part of it would paint a hole. The ring buffer
          // is the authority for the same window - past its position, everything it holds.
          if (at !== undefined && stream.buffer.covers(stream.epoch, at)) {
            const data = stream.buffer.since(at);
            if (data.length > 0) {
              send(client.socket, {
                t: "chunk",
                sessionId: message.sessionId,
                epoch: stream.epoch,
                seq: stream.buffer.headSeq,
                data: data.toString("utf8"),
              });
            }
          } else {
            send(client.socket, {
              t: "snapshot",
              sessionId: message.sessionId,
              epoch: stream.epoch,
              seq: stream.buffer.headSeq,
              data: stream.buffer.snapshot().toString("utf8"),
            });
          }
          held = [];
        }
        for (const chunk of held) {
          // Anything the snapshot already contains would be painted twice.
          if (at !== undefined && chunk.seq <= at) continue;
          send(client.socket, {
            t: "chunk",
            sessionId: message.sessionId,
            epoch: chunk.epoch,
            seq: chunk.seq,
            data: chunk.data.toString("utf8"),
          });
        }
        send(client.socket, {
          t: "state",
          sessionId: message.sessionId,
          state: stream.state(),
          ...(stream.exitCode === undefined ? {} : { exitCode: stream.exitCode }),
        });
        return;
      }
      case "detach": {
        client.attached.get(message.sessionId)?.();
        client.attached.delete(message.sessionId);
        stream.detach(client.id);
        applySize(message.sessionId);
        return;
      }
      case "input": {
        // Never echoed back specially: it returns as ordinary output, and the agent may be in a
        // mode that transforms or refuses what was typed.
        deps.sendInput(message.sessionId, message.data);
        return;
      }
      case "resize": {
        stream.resize(client.id, message.cols, message.rows);
        applySize(message.sessionId);
        return;
      }
      case "resync": {
        await sendPosition(client, message.sessionId, stream, message.haveEpoch, message.haveSeq);
        return;
      }
    }
  };

  // A cold snapshot is the expensive frame, so callers arriving mid-flight share it. Raced against
  // a bound that evicts: a never-returning tmux would pin an entry and every later caller too.
  const snapshots = new Map<
    string,
    { generation: number; promise: Promise<Awaited<ReturnType<typeof buildSnapshot>>> }
  >();
  let nextGeneration = 0;

  const buildCoalescedSnapshot = async (
    sessionId: string,
    stream: SessionStream,
  ): Promise<Awaited<ReturnType<typeof buildSnapshot>>> => {
    // The generation whose failure this caller already inherited, so the loop only moves forward.
    let inherited: number | undefined;
    let inheritedFailures = 0;
    for (;;) {
      const inFlight = snapshots.get(sessionId);
      if (inFlight === undefined || inFlight.generation === inherited) break;
      // Bounded: each is up to a whole SNAPSHOT_TIMEOUT_MS spent inside one `attach`, holding that
      // client's queue of live output.
      if (inheritedFailures >= MAX_INHERITED_SNAPSHOT_FAILURES) break;
      try {
        return await inFlight.promise;
      } catch {
        // Sharing the SUCCESS is the point; sharing the FAILURE lets one flood detach every client
        // beside it. A joiner retries, but looks again first or one rejection starts N builds.
        inherited = inFlight.generation;
        inheritedFailures += 1;
      }
    }
    const generation = nextGeneration++;
    // A late settle from a build that already timed out must not delete a newer entry.
    const evict = (): void => {
      if (snapshots.get(sessionId)?.generation === generation) snapshots.delete(sessionId);
    };
    const started = buildSnapshot({
      buffer: stream.buffer,
      captureHistory: async () => await deps.captureHistory(sessionId),
      alternateScreen: async () => await deps.isAlternateScreen(sessionId),
      paneModes: async () => await deps.paneModes(sessionId),
      repaint: async () => await deps.repaint(sessionId),
    });
    const limit = deps.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const bounded = Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          evict();
          reject(
            new Error(`the snapshot for ${sessionId} did not finish within ${String(limit)}ms`),
          );
        }, limit);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      evict();
    });
    snapshots.set(sessionId, { generation, promise: bounded });
    return await bounded;
  };

  const sendPosition = async (
    client: Client,
    sessionId: string,
    stream: SessionStream,
    haveEpoch: string | undefined,
    haveSeq: number | undefined,
  ): Promise<number | undefined> => {
    const plan = planAttach(stream.buffer, haveEpoch, haveSeq);
    if (plan.kind === "chunks") {
      const data = stream.buffer.since(plan.from);
      if (data.length > 0) {
        send(client.socket, {
          t: "chunk",
          sessionId,
          epoch: stream.epoch,
          seq: stream.buffer.headSeq,
          data: data.toString("utf8"),
        });
      }
      return stream.buffer.headSeq;
    }
    const snapshot = await buildCoalescedSnapshot(sessionId, stream);
    send(client.socket, { t: "snapshot", sessionId, ...snapshot });
    return snapshot.seq;
  };

  const pingIntervalMs = deps.pingIntervalMs ?? PING_INTERVAL_MS;

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
      // The client-visible half: the ping above is a control frame the browser answers below the
      // JavaScript API, so this data frame is what the client's own silence bound is measured against.
      send(client.socket, { t: "ping", intervalMs: pingIntervalMs });
    }
  }, pingIntervalMs);
  // Not a reason to keep the process alive.
  heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
    pushState: (sessionId, state, exitCode) => {
      for (const client of clients) {
        send(client.socket, {
          t: "state",
          sessionId,
          state,
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      }
    },
  };
};
