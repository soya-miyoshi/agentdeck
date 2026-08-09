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

/**
 * How many other clients' failed snapshot builds one `attach` may wait out before it stops
 * joining and builds its own.
 *
 * Each individual build is bounded by SNAPSHOT_TIMEOUT_MS, but joining an unbounded chain of them
 * is not: caller k of a storm of N would wait out builds 1..k-1 in turn, so the last one sits in
 * the attach path for N x SNAPSHOT_TIMEOUT_MS while holding its queue of the session's output.
 * Two inherited failures is the pre-branch worst case (one inherited build plus your own), and it
 * keeps the storm fix intact: the first joiner to wake still installs the shared retry.
 */
export const MAX_INHERITED_SNAPSHOT_FAILURES = 2;

/**
 * How many bytes of live output one attaching client may hold while its snapshot is being built.
 *
 * The queue exists to keep chunks from arriving ahead of the snapshot, and it is normally a
 * handful of frames. A session printing at a few MB/s against a stalled tmux server is the case
 * that turns it into a heap of the whole stall, per attaching socket. Past this the queue is
 * dropped and the client is caught up from the ring buffer instead, which is bounded by its own
 * capacity.
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
  /** The live screen for a cold snapshot, and the seq the bytes of it end at. */
  repaint: (sessionId: string) => Promise<{ data: string; seq: number }>;
  /**
   * The whole session list, sent to a socket the moment it opens.
   *
   * A newly-opened socket otherwise has no baseline. `pushState` reaches the sockets that are
   * open at that instant and `Hub.announce` dedupes server-wide, so every transition a phone's
   * socket was dropped for - which plan 002 says is the normal case - was lost to it: the state
   * was already announced, so it was never re-announced, and the reconnect ladder only re-attaches
   * the tabs the user had actually opened. A session that went `waiting` while the screen was off
   * stayed `working` in the strip until a full page reload, which is the strip answering "which
   * one needs you" with "none of them" while one does.
   */
  listSessions: () => Promise<Session[]>;
  /** Raw bytes the user typed, straight to the PTY. */
  sendInput: (sessionId: string, data: string) => void;
  /** Apply the minimum-over-attached-clients size. */
  applyPaneRows: (sessionId: string, rows: number) => void;
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

/**
 * How much a single socket may have waiting to go out before it is treated as gone.
 *
 * A stalled client - a phone that has lost signal but not yet closed - accepts frames into
 * `bufferedAmount` forever, and this server pushes to every socket on every state change. Without
 * a ceiling that buffer is the only thing that grows, on a process nothing restarts. Well above a
 * snapshot, so a slow client is not dropped for being slow at something legitimate.
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
   * Tell every open socket a session's state, whether or not it is attached to that session.
   *
   * Broadcast rather than sent to the attached, because the strip shows a row per session and
   * plan 002 is explicit that it must be able to say "this one needs you" without attaching to
   * every session at once. A state frame that only reached attached clients would make the status
   * of an unlooked-at tab arrive on the next poll, and there is no poll.
   */
  pushState: (sessionId: string, state: SessionState, exitCode?: number) => void;
}

export const attachWebSocketServer = (server: Server, deps: WsDeps): WsHandle => {
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

    // The width this server's PTYs actually hold the panes at, before anything else and without
    // waiting on tmux. The client has a `PANE_COLS` of its own, but it is compiled into a bundle
    // that is rebuilt and restarted separately from this process - so on the phone a rebuilt client
    // rendered 50 columns into a pane still wrapped at 40, and the ten columns of difference read
    // as padding down the right-hand edge rather than as a version skew. Sent synchronously and not
    // folded into the `sessions` frame below, which is async and allowed to fail: a capture that
    // could not answer must not also cost the client its width.
    send(socket, { t: "hello", cols: PANE_COLS });

    // The baseline, before any frame this client sends. Everything after it is a delta, and a
    // socket that missed deltas while it was down has no other way back to the truth: the state
    // dedupe is server-wide, so what was announced while nobody was listening is never repeated.
    // A failure here costs this socket its resettle, not its connection - the list is fetched over
    // HTTP too - so it is logged rather than thrown.
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
    const rows = paneRows(stream.clients.values());
    // undefined means nobody is attached, and an empty set resizes nothing: the pane keeps the
    // last size anyone asked for. A client's cols never reach here - see PANE_COLS.
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
        //
        // And the queue is capped. A build the snapshot timeout is still waiting out is up to
        // fifteen seconds of whatever the session prints, retained per attaching socket, and the
        // chunks are the stream's own Buffers. Past MAX_QUEUED_ATTACH_BYTES the queue is dropped
        // and the client is caught up from the ring buffer after the snapshot instead, so it gets
        // bytes rather than a hole.
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
          // Undo what THIS call set up, and nothing else. A re-attach - which the reconnect ladder
          // now sends by itself - would otherwise tear down a working attachment that predates it,
          // leaving a socket that is still OPEN with no listener and no way back: the client only
          // sends `attach` on mount and on reconnect, so the tab shows a stale screen forever while
          // the strip keeps reporting state from the registry. `applySize` after that detach also
          // reflows the OTHER clients' panes mid-session.
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
          // The queue was thrown away, so the flush cannot be trusted to be a complete run of
          // bytes - flushing part of one paints a hole. The ring buffer is the authority for the
          // same window: send what it holds past the snapshot's position, or, if it has rolled
          // past that position too, everything it holds as a fresh snapshot frame.
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
    // The generation whose failure this caller has already inherited, so it is never inherited
    // twice and the loop can only ever move forward.
    let inherited: number | undefined;
    let inheritedFailures = 0;
    for (;;) {
      const inFlight = snapshots.get(sessionId);
      if (inFlight === undefined || inFlight.generation === inherited) break;
      // Bounded, because each of these is up to a whole SNAPSHOT_TIMEOUT_MS spent inside one
      // `attach` while it holds that client's queue of live output.
      if (inheritedFailures >= MAX_INHERITED_SNAPSHOT_FAILURES) break;
      try {
        return await inFlight.promise;
      } catch {
        // Coalescing is an optimisation, not a verdict. Sharing the SUCCESS is the point; sharing
        // the FAILURE means one client's flood - or one capture-pane past its buffer - decides the
        // outcome for every client that happened to attach beside it, and the attach path treats a
        // failed snapshot as a reason to detach. So a joiner makes its own attempt.
        //
        // But it must LOOK AGAIN first, which is what this loop is for. Every joiner of a failed
        // build is woken by the same rejection, so falling straight through made each of them
        // start a build: eight tabs coming back from one stalled server turned one failure into
        // eight concurrent capture-panes at the tmux server that was already the problem, which is
        // the storm the coalescing exists to prevent, reachable only through the failure path.
        // Measured at eight builds for eight re-attaches before this loop - src/ws.test.ts.
        //
        // Looking again is not merely an optimisation here: the first joiner to wake has already
        // installed its retry by the time the rest look, so the rest join a real, live attempt
        // rather than duplicating it. The loop cannot spin, because it never inherits the same
        // generation twice and a newer entry is always a strictly larger one.
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
      // AND the client-visible half, on the same timer and regardless of agent activity. The ping
      // frame above is a control frame the browser answers below the JavaScript API, so a page can
      // neither see it nor be told the socket went quiet; this data frame is what the client's own
      // silence bound is measured against. It costs the sender's budget nothing - `withinRate`
      // counts inbound frames only - and the client never answers it, so it cannot spend a user's
      // input allowance either.
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
