import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { buildSnapshot, planAttach } from "./attach.ts";
import { parseClientMessage, paneSize, type ServerMessage } from "./protocol.ts";
import type { SessionStream } from "./stream.ts";
import { tokenMatches } from "./token.ts";

// One socket, multiplexed over every attached session. Not one per tab: phones background
// aggressively, and re-establishing N sockets on wake is N chances to fail.

/** Server pings this often; a client that has not ponged within twice this is closed. */
export const PING_INTERVAL_MS = 15_000;

// A phone that loses signal mid-stream leaves a connection dead at both ends and closed at
// neither. Nothing arrives, nothing errors, and the strip shows a status frozen at whatever it
// last said - a confidently wrong status, which is the one output this design refuses. The
// reconnection ladder never runs either, because from the client's side nothing has gone wrong.
export const PONG_TIMEOUT_MS = PING_INTERVAL_MS * 2;

// Every frame is handled fire-and-forget, and `resync` reaches capture-pane plus refresh-client
// without the sender being attached to anything. That was survivable while every client was a
// person's thumb; it stops being survivable once a client reconnects on its own, because a client
// stuck in a loop retries without anyone watching it. So one socket gets a frame budget per
// window; the rest of the window is dropped rather than closed, since a phone whose tab is looping
// should lose the loop and not its terminal.
export const RATE_WINDOW_MS = 1000;
/** Frames one socket may send per window. Far above typing, far below a repaint loop. */
export const MAX_FRAMES_PER_WINDOW = 100;

// A frame budget bounds how MANY frames arrive, not how big they are or what they cost. Two
// separate bounds close that gap.
//
// Bytes: ws defaults maxPayload to 100 MiB, so 100 frames a second is up to 100 MB each, fully
// buffered by the receiver before `message` fires and copied twice more by toString and
// JSON.parse. src/http.ts already refuses a request body over 64 KB for exactly this reason; the
// socket carries the same kinds of message, so it gets the same number.
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * How long a coalesced snapshot build may run before it is abandoned and evicted.
 *
 * Generous: a real capture-pane over deep scrollback is slow, and cutting a working build short
 * costs the tab its history. What it exists to bound is the build that never settles at all.
 */
export const SNAPSHOT_TIMEOUT_MS = 15_000;

export interface WsDeps {
  token: string;
  origin: string | undefined;
  /** The live stream for a session, or undefined if there is no such session. */
  streamFor: (sessionId: string) => SessionStream | undefined;
  /** Scrollback for a cold snapshot. The depth belongs to whoever implements this. */
  captureHistory: (sessionId: string) => Promise<string>;
  /** Whether the pane is on the alternate screen, where there is no scrollback to show. */
  isAlternateScreen: (sessionId: string) => Promise<boolean>;
  /** The live screen for a cold snapshot, and the seq the bytes of it end at. */
  repaint: (sessionId: string) => Promise<{ data: string; seq: number }>;
  /** Raw bytes the user typed, straight to the PTY. */
  sendInput: (sessionId: string, data: string) => void;
  /** Apply the minimum-over-attached-clients size. */
  applyPaneSize: (sessionId: string, cols: number, rows: number) => void;
  /**
   * How often to ping. Defaults to PING_INTERVAL_MS.
   *
   * Present so the half-open test can run the same mechanism on a scale a test suite can wait
   * out; nothing in the server sets it.
   */
  pingIntervalMs?: number;
  /**
   * How long a coalesced snapshot build may run. Defaults to SNAPSHOT_TIMEOUT_MS.
   *
   * Present so the hung-capture test can run the same mechanism on a scale a test suite can wait
   * out; nothing in the server sets it.
   */
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

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

export const attachWebSocketServer = (server: Server, deps: WsDeps): { close: () => void } => {
  // noServer, so the upgrade is authenticated before any WebSocket exists. Letting `ws` handle
  // the upgrade would mean a socket that opens and then closes, which a client cannot tell from
  // a network problem.
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

    // THE SERVER MUST ECHO THE SELECTED SUBPROTOCOL or the browser closes the connection. The
    // failure is at the socket layer, before any code of ours runs, and presents as "the socket
    // just will not open" with nothing logged.
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

    // FIRST, before anything else can be registered. `ws` re-emits every receiver-level protocol
    // violation - invalid UTF-8 in a text frame, a bad opcode, an unmasked client frame, a payload
    // past maxPayload - as an `error` event on this socket. An EventEmitter with no `error`
    // listener THROWS, and nothing installs an uncaughtException handler, so a five-byte malformed
    // frame from one buggy client took the whole server down and every other phone's socket with
    // it. The frame budget cannot help: the receiver rejects the frame before `message` fires.
    socket.on("error", (error: unknown) => {
      console.error("agentdeck: ws socket error:", error);
      // The close handler does the detach and cleanup; ws closes the socket after an error itself,
      // and terminate() here makes sure a socket that somehow did not is not left attached.
      socket.terminate();
    });
    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("message", (raw: Buffer) => {
      if (!withinRate(client)) return;
      // The third fire-and-forget site, and the one left behind when the two `hub.sync()` calls
      // were hardened. handleMessage reaches capture-pane through the snapshot an attach builds,
      // and Tmux rethrows anything that is not a missing session or an empty server - so one
      // failing capture became an unhandled rejection, which exits Node, on a process nothing
      // restarts. A tmux failure costs this message, not every attached phone's socket.
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
    const size = paneSize(stream.clients.values());
    // undefined means nobody is attached, and an empty set resizes nothing: the pane keeps the
    // last size anyone asked for.
    if (size !== undefined) deps.applyPaneSize(sessionId, size.cols, size.rows);
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
        // The forwarding listener has to exist before the snapshot is built - the repaint's own
        // bytes come back through this stream, and a listener registered afterwards would miss
        // whatever arrived while `capture-pane` and `refresh-client` were running. But it must not
        // SEND before the snapshot: a client with no position yet answers a chunk with `resync`
        // (src/client/stream-position.ts), so every cold attach cost a second full snapshot -
        // another capture-pane, another refresh-client, another collection window. Observed on a
        // real attach: three chunk frames arrived ahead of the snapshot.
        //
        // So it queues until the snapshot is away, then flushes only what the snapshot does not
        // already reflect.
        let queued: { epoch: string; seq: number; data: Buffer }[] | undefined = [];
        if (!client.attached.has(message.sessionId)) {
          const off = stream.onChunk((chunk) => {
            if (queued !== undefined) {
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
        // The flush and the listener's fate are unconditional. A snapshot that fails - a
        // capture-pane past its 16 MB buffer is the ordinary way - used to leave `queued` an
        // array forever: the listener stayed registered, every later byte was pushed into a list
        // nothing drains, and `client.attached.has(sessionId)` meant a retry found the poisoned
        // listener rather than registering a working one. The tab was silently blind for the life
        // of the process, and the retained bytes were bounded by nothing.
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
          client.attached.get(message.sessionId)?.();
          client.attached.delete(message.sessionId);
          stream.detach(client.id);
          applySize(message.sessionId);
          throw error;
        } finally {
          held = queued ?? [];
          queued = undefined;
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
        // Never echoed back specially - it returns as ordinary output, because that is what the
        // PTY does. The client must not optimistically render typed characters: the agent may be
        // in a mode that transforms or refuses them.
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

  // A cold snapshot is the expensive frame: capture-pane for the history and another spawn to ask
  // whether the pane is on the alternate screen, each allowed a 16 MB buffer. Hub.repaint already
  // coalesces its own call, but these do not, so a hundred `resync` frames inside the frame budget
  // meant a hundred concurrent snapshot builds - the loop the budget is supposed to stop, running
  // at full speed inside it. Callers that arrive while one build is in flight share its result;
  // each still sends its own frame.
  //
  // Coalescing is only safe if every entry is guaranteed to leave the map. `Tmux.#exec` passes no
  // execFile `timeout`, so a tmux server that stops answering is a capture-pane that never
  // returns - the condition probeTmux already sets a timeout for. An entry evicted only by
  // `.finally()` would then be pinned forever, and every later caller for that session, on every
  // socket, would join the dead build and wait forever too: a permanently blank tab that reports
  // itself attached. So the build is raced against a bound, and the bound evicts.
  const snapshots = new Map<
    string,
    { generation: number; promise: Promise<Awaited<ReturnType<typeof buildSnapshot>>> }
  >();
  let nextGeneration = 0;

  const buildCoalescedSnapshot = async (
    sessionId: string,
    stream: SessionStream,
  ): Promise<Awaited<ReturnType<typeof buildSnapshot>>> => {
    const inFlight = snapshots.get(sessionId);
    if (inFlight !== undefined) return await inFlight.promise;
    const generation = nextGeneration++;
    // A late settle from a build that already timed out must not delete a newer entry.
    const evict = (): void => {
      if (snapshots.get(sessionId)?.generation === generation) snapshots.delete(sessionId);
    };
    const started = buildSnapshot({
      buffer: stream.buffer,
      captureHistory: async () => await deps.captureHistory(sessionId),
      alternateScreen: async () => await deps.isAlternateScreen(sessionId),
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

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, deps.pingIntervalMs ?? PING_INTERVAL_MS);
  // Not a reason to keep the process alive.
  heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
};
