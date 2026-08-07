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

export interface WsDeps {
  token: string;
  origin: string | undefined;
  /** The live stream for a session, or undefined if there is no such session. */
  streamFor: (sessionId: string) => SessionStream | undefined;
  /** Scrollback for a cold snapshot. The depth belongs to whoever implements this. */
  captureHistory: (sessionId: string) => Promise<string>;
  /** Raw bytes the user typed, straight to the PTY. */
  sendInput: (sessionId: string, data: string) => void;
  /** Apply the minimum-over-attached-clients size. */
  applyPaneSize: (sessionId: string, cols: number, rows: number) => void;
}

interface Client {
  id: string;
  socket: WebSocket;
  alive: boolean;
  /** Unsubscribe callbacks for every session this socket is attached to. */
  attached: Map<string, () => void>;
}

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

export const attachWebSocketServer = (server: Server, deps: WsDeps): { close: () => void } => {
  // noServer, so the upgrade is authenticated before any WebSocket exists. Letting `ws` handle
  // the upgrade would mean a socket that opens and then closes, which a client cannot tell from
  // a network problem.
  const wss = new WebSocketServer({ noServer: true });
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
    };
    clients.add(client);

    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("message", (raw: Buffer) => {
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
        if (!client.attached.has(message.sessionId)) {
          const off = stream.onChunk((chunk) => {
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
        await sendPosition(client, message.sessionId, stream, message.haveEpoch, message.haveSeq);
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

  const sendPosition = async (
    client: Client,
    sessionId: string,
    stream: SessionStream,
    haveEpoch: string | undefined,
    haveSeq: number | undefined,
  ): Promise<void> => {
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
      return;
    }
    const snapshot = await buildSnapshot({
      buffer: stream.buffer,
      captureHistory: async () => await deps.captureHistory(sessionId),
    });
    send(client.socket, { t: "snapshot", sessionId, ...snapshot });
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
  }, PING_INTERVAL_MS);
  // Not a reason to keep the process alive.
  heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
};
