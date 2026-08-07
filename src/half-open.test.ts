import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";

import { WebSocket } from "ws";

import {
  Connection,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type ConnectionStatus,
  type SocketFactory,
} from "./client/connection.ts";
import { SessionStream } from "./stream.ts";
import {
  attachWebSocketServer,
  MAX_FRAMES_PER_WINDOW,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from "./ws.ts";

// THE HALF-OPEN CONNECTION, which is the only failure the ping exists for.
//
// A socket that is closed, destroyed or errored proves nothing about this: all three produce an
// event the server already reacts to without any ping at all. The connection this file drives is
// genuinely silent in both directions and closed at neither end - a TCP proxy sits between the ws
// client and the server, forwards both ways, and then simply STOPS forwarding while holding both
// sockets open. That is the closest honest model of a phone that walked out of signal: the peer is
// gone, no FIN, no RST, nothing arrives, nothing errors.
//
// What the proxy does not model: a real radio drop also stops the SERVER's writes from being
// acknowledged, so a large enough write would eventually fill the send buffer and time out at the
// TCP layer. Here the proxy accepts the server's bytes happily. That difference makes the test
// HARDER rather than easier - the server gets no help from the transport, so the ping is the only
// thing that can notice, which is precisely what is being demonstrated.
//
// The ping runs on a scaled interval so a test suite can wait it out. The mechanism, the phase
// (mark not-alive, ping, terminate on the next tick if no pong came back) and the two-intervals
// bound are the production ones; only the length of the interval differs, and the relation
// between the two production constants is asserted below so the scaling cannot drift.

const TOKEN = "half-open-token";
const TEST_PING_MS = 300;
const TEST_PONG_TIMEOUT_MS = TEST_PING_MS * 2;

let server: Server;
let closeWs: () => void;
let port: number;
const dead = new SessionStream({ sessionId: "dead" });
const live = new SessionStream({ sessionId: "live" });
const input: string[] = [];

before(async () => {
  server = createHttpServer();
  closeWs = attachWebSocketServer(server, {
    token: TOKEN,
    origin: undefined,
    streamFor: (id) => (id === "dead" ? dead : id === "live" ? live : undefined),
    captureHistory: async () => await Promise.resolve(""),
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint: async () => await Promise.resolve({ data: "", seq: 0 }),
    sendInput: (_id, data) => input.push(data),
    applyPaneSize: () => undefined,
    pingIntervalMs: TEST_PING_MS,
  }).close;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  closeWs();
  server.close();
});

interface Proxy {
  port: number;
  /** Stop forwarding, in both directions, without closing either side. */
  freeze: () => void;
  close: () => void;
}

const startProxy = async (targetPort: number): Promise<Proxy> => {
  let frozen = false;
  const sockets: Socket[] = [];
  const tcp = createTcpServer((downstream) => {
    const upstream = connect(targetPort, "127.0.0.1");
    downstream.on("data", (bytes) => {
      if (!frozen) upstream.write(bytes);
    });
    upstream.on("data", (bytes) => {
      if (!frozen) downstream.write(bytes);
    });
    // Nothing forwards a close either. A proxy that tore the other side down on FIN would hand
    // the server the event it is not allowed to have.
    downstream.on("error", () => undefined);
    upstream.on("error", () => undefined);
    sockets.push(downstream, upstream);
  });
  await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
  return {
    port: (tcp.address() as AddressInfo).port,
    freeze: () => {
      frozen = true;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      tcp.close();
    },
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

interface Attached {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  lastStateAt: number;
}

const attach = async (wsPort: number, sessionId: string): Promise<Attached> => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(wsPort)}`, TOKEN);
  const attached: Attached = { socket, frames: [], lastStateAt: 0 };
  socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    attached.frames.push(frame);
    // The only status the client ever hears about. Nothing else pushes `state` on a timer, which
    // is exactly why a status that stopped changing cannot be read as a dead socket.
    if (frame.t === "state") attached.lastStateAt = Date.now();
  });
  await new Promise<void>((done) => socket.once("open", done));
  socket.send(JSON.stringify({ t: "attach", sessionId, cols: 80, rows: 24 }));
  // An attach that never landed would otherwise fail further down as something else entirely.
  assert.ok(await waitFor(() => attached.lastStateAt > 0, 2000), `attach to ${sessionId} failed`);
  return attached;
};

interface ClientUnderTest {
  connection: Connection;
  /** Statuses the client reported after it was open. Empty means it still believes it is fine. */
  statuses: ConnectionStatus[];
  /** Raw frames this client put on the wire, so an idle tab's cost can be counted. */
  sent: string[];
  /** When this session's state last changed, which is the clock the heartbeat is measured against. */
  lastStateAt: () => number;
}

/**
 * The real client module against the real server, over a socket that may be proxied.
 *
 * `browserSocket` is the one file that names the browser's WebSocket, and it is the only piece not
 * reachable from node:test; everything the heartbeat lives in - Connection's silence bound, its
 * ladder, its status - is exercised unmodified.
 */
const connectClient = async (wsPort: number, sessionId: string): Promise<ClientUnderTest> => {
  const sent: string[] = [];
  let pings = 0;
  const connect: SocketFactory = (token, handlers) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(wsPort)}`, token);
    socket.on("open", () => handlers.opened());
    socket.on("message", (raw: Buffer) => {
      const text = raw.toString("utf8");
      if ((JSON.parse(text) as { t?: string }).t === "ping") pings += 1;
      handlers.message(text);
    });
    socket.on("close", () => handlers.closed());
    socket.on("error", () => undefined);
    return {
      send: (raw) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        sent.push(raw);
        socket.send(raw);
      },
      close: () => {
        socket.close();
      },
    };
  };

  const statuses: ConnectionStatus[] = [];
  let opened = false;
  let lastStateAt = 0;
  const connection = new Connection(
    { token: TOKEN, connect, verifyToken: () => Promise.resolve(true) },
    {
      render: () => undefined,
      state: () => {
        // The only status the client ever hears about, and nothing pushes it on a timer - which is
        // exactly why a status that stopped changing cannot be read as a dead socket.
        lastStateAt = Date.now();
      },
      sessions: () => undefined,
      error: () => undefined,
      status: (status) => {
        if (status === "open") opened = true;
        else if (opened) statuses.push(status);
      },
      unauthorized: () => undefined,
    },
  );
  connection.start();
  assert.ok(await waitFor(() => opened, 2000), `client for ${sessionId} never opened`);
  connection.attach(sessionId, 80, 24);
  assert.ok(await waitFor(() => lastStateAt > 0, 2000), `attach to ${sessionId} failed`);
  // The client's silence bound is the SERVER's interval, carried on the heartbeat itself, and until
  // the first one lands it is still the production-sized default. Freezing the network before then
  // would be timing a bound this suite never scaled.
  assert.ok(
    await waitFor(() => pings > 0, 2000),
    `no heartbeat reached the client for ${sessionId}`,
  );
  return { connection, statuses, sent, lastStateAt: () => lastStateAt };
};

/** Errors the server sent this client, read out of the frames the harness already collects. */
const errorsOf = (attached: Attached): string[] =>
  attached.frames
    .filter((frame) => frame.t === "error")
    .map((frame) => (typeof frame.message === "string" ? frame.message : ""));

void describe("a half-open connection", () => {
  void test("production keeps the two-intervals relation this test scales", () => {
    assert.equal(PONG_TIMEOUT_MS, PING_INTERVAL_MS * 2);
  });

  void test("is noticed by the ping, and sooner than a status that stopped changing could be", async () => {
    const proxy = await startProxy(port);
    const deadClient = await attach(proxy.port, "dead");
    const liveClient = await attach(port, "live");
    // Cleanup has to survive a failing assertion. Without it, the negative control - taking the
    // terminate() away - leaves a half-open socket and a proxy holding the loop open, and the run
    // hangs instead of reporting which assertion failed. A test whose failure mode is a hang is a
    // test nobody can read the result of.
    try {
      assert.equal(dead.attachedCount, 1);
      assert.equal(live.attachedCount, 1);

      const framesBeforeFreeze = deadClient.frames.length;
      const frozenAt = Date.now();
      proxy.freeze();

      // The server drops the client when the ping goes unanswered: it detaches from the stream in
      // its close handler, so the attached count falling is the server having NOTICED, observed
      // where the noticing happens rather than where a socket event happens.
      const noticed = await waitFor(() => dead.attachedCount === 0, TEST_PONG_TIMEOUT_MS * 3);
      const pingNoticedMs = Date.now() - frozenAt;

      assert.ok(noticed, "the ping never noticed the half-open connection");
      assert.ok(
        pingNoticedMs <= TEST_PONG_TIMEOUT_MS,
        `ping noticed after ${String(pingNoticedMs)}ms, past the ${String(TEST_PONG_TIMEOUT_MS)}ms bound`,
      );

      // The connection really was half-open, not closed or errored: the client end is still OPEN and
      // heard nothing at all after the freeze. Neither of those is true of a socket that was closed
      // or destroyed, which is the whole reason this test carries a proxy.
      assert.equal(deadClient.socket.readyState, WebSocket.OPEN);
      assert.equal(deadClient.frames.length, framesBeforeFreeze);

      // THE OTHER CLOCK. The dead session's status has not changed since its attach - and neither
      // has the live one's, because an idle agent legitimately says nothing for minutes. Both look
      // identical from the strip, which is the confidently-wrong tab this design refuses.
      const deadStatusUnchangedMs = Date.now() - deadClient.lastStateAt;
      const liveStatusUnchangedMs = Date.now() - liveClient.lastStateAt;

      // The live socket is demonstrably alive at this instant: an input round-trips to the server
      // while its status has been just as stale as the dead one's.
      input.length = 0;
      liveClient.socket.send(JSON.stringify({ t: "input", sessionId: "live", data: "x" }));
      assert.ok(await waitFor(() => input.length === 1, 2000), "the live socket was not alive");

      // Both timings, in the assertion. Any status-staleness threshold low enough to have called the
      // dead socket by now would have called the live one at the same moment - so the status clock
      // cannot beat the ping without being wrong about a healthy session.
      assert.ok(
        pingNoticedMs <= deadStatusUnchangedMs && liveStatusUnchangedMs >= pingNoticedMs,
        `ping noticed at ${String(pingNoticedMs)}ms; the dead session's status had been unchanged for ` +
          `${String(deadStatusUnchangedMs)}ms and a LIVE session's for ${String(liveStatusUnchangedMs)}ms`,
      );
    } finally {
      deadClient.socket.terminate();
      liveClient.socket.close();
      proxy.close();
    }
  });

  // THE CLIENT HALF, over the same proxy. The server's ping is a WebSocket control frame, which a
  // browser answers below the JavaScript API - the page never sees it - so nothing above proves the
  // CLIENT can notice anything. What the client measures instead is the `{ t: "ping" }` data frame
  // the server sends on the same timer regardless of agent activity, and the tab that must survive
  // it untouched is the one whose agent has simply gone quiet.
  void test("the client's heartbeat default agrees with the server's interval", () => {
    assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, PING_INTERVAL_MS);
  });

  void test("the client notices a pulled network, sooner than a status that stopped changing, and never calls a quiet agent dead", async () => {
    const proxy = await startProxy(port);
    const dropped = await connectClient(proxy.port, "dead");
    const quiet = await connectClient(port, "live");
    try {
      assert.equal(dead.attachedCount, 1);
      assert.equal(live.attachedCount, 1);
      assert.equal(dropped.connection.status, "open");

      const sentWhileIdle = quiet.sent.length;
      const frozenAt = Date.now();
      proxy.freeze();

      // The client's own verdict: the first status it reports after the network is pulled. Not the
      // server's terminate(), and not a socket event - through a frozen proxy there is none.
      const noticed = await waitFor(() => dropped.statuses.length > 0, TEST_PONG_TIMEOUT_MS * 6);
      const clientNoticedMs = Date.now() - frozenAt;
      assert.ok(noticed, "the client never noticed the pulled network");
      // The silence bound plus one backoff delay before the ladder's first visible step.
      assert.ok(
        clientNoticedMs <= TEST_PONG_TIMEOUT_MS * 3,
        `the client noticed after ${String(clientNoticedMs)}ms`,
      );

      // BOTH CLOCKS, in the assertion. Neither session's status has changed since its attach - an
      // idle agent legitimately says nothing for minutes - so a status-staleness threshold low
      // enough to have called the dead socket by now would have called the LIVE one at the same
      // moment. The heartbeat clock beats the status clock without being wrong about a healthy tab.
      const deadStatusUnchangedMs = Date.now() - dropped.lastStateAt();
      const quietStatusUnchangedMs = Date.now() - quiet.lastStateAt();
      assert.ok(
        clientNoticedMs <= deadStatusUnchangedMs && quietStatusUnchangedMs >= clientNoticedMs,
        `the client noticed at ${String(clientNoticedMs)}ms; the dead tab's status had been unchanged for ` +
          `${String(deadStatusUnchangedMs)}ms and a LIVE tab's for ${String(quietStatusUnchangedMs)}ms`,
      );

      // THE FAILURE MODE THIS DESIGN REFUSES. The quiet tab's agent has produced nothing for the
      // whole run - several heartbeat intervals - and it is still open, never reconnected, never
      // reported dead. A blind silence timer would have dropped it at the same moment as the other.
      await new Promise((resolve) => setTimeout(resolve, TEST_PONG_TIMEOUT_MS * 2));
      assert.equal(quiet.connection.status, "open");
      assert.deepEqual(quiet.statuses, []);
      assert.equal(live.attachedCount, 1);

      // And the heartbeat is outside both budgets: the quiet client answered none of those frames,
      // so it spent nothing of the per-window input allowance, and its typing still goes through.
      assert.equal(quiet.sent.length, sentWhileIdle, "an idle tab sent frames it did not need to");
      input.length = 0;
      quiet.connection.input("live", "x");
      assert.ok(await waitFor(() => input.length === 1, 2000), "the quiet tab could not type");
    } finally {
      dropped.connection.stop();
      quiet.connection.stop();
      proxy.close();
    }
  });

  void test("one socket cannot send frames without a bound", async () => {
    const client = await attach(port, "live");
    input.length = 0;

    const sent = MAX_FRAMES_PER_WINDOW + 50;
    for (let i = 0; i < sent; i++) {
      client.socket.send(JSON.stringify({ t: "input", sessionId: "live", data: "x" }));
    }

    await waitFor(() => errorsOf(client).length > 0, 2000);
    // Same reason as above: an unclosed socket turns a failed assertion into a hung run, so the
    // no-bound case has to report as a failure rather than as silence.
    try {
      const errors = errorsOf(client);
      assert.ok(input.length < sent, "every frame was handled, so there is no bound");
      assert.ok(input.length <= MAX_FRAMES_PER_WINDOW);
      assert.equal(errors.length, 1, "one sentence per window, not one per dropped frame");
      assert.match(errors[0] ?? "", /messages in a second/);
    } finally {
      client.socket.close();
    }
  });
});

// THE SERVER'S HALF of the client-visible heartbeat, separately from the client that consumes it.
// The end-to-end test above passes if the two halves agree; these say what the server owes any
// client, including the two properties plan 002 chose this frame FOR - that it does not depend on
// a session, and that it does not depend on the agent doing anything.
void describe("the client-visible heartbeat, as the server sends it", () => {
  void test("reaches a socket that has attached nothing at all", async () => {
    // Why `state` on a timer was rejected: `state` is per session, so this socket - open,
    // authenticated, attached to nothing - would receive no heartbeat whatsoever and time itself
    // out while perfectly healthy. A socket the user has not yet picked a tab in is the ordinary
    // state of a page that just loaded.
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`, TOKEN);
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
    });
    await new Promise<void>((done) => socket.once("open", done));
    try {
      const pings = (): Record<string, unknown>[] =>
        frames.filter((frame) => frame["t"] === "ping");
      assert.ok(
        await waitFor(() => pings().length >= 2, TEST_PING_MS * 8),
        "an unattached socket was never sent a heartbeat",
      );
      // On a timer, whatever the agent is doing: neither session wrote a byte for the whole wait,
      // and nothing here asked for anything.
      assert.deepEqual(
        frames.filter((frame) => frame["t"] !== "ping"),
        [],
        "something other than the heartbeat arrived, so the heartbeat is not what was measured",
      );
      // The interval travels on the frame, and it is the SERVER's - this suite runs a scaled one
      // precisely so a client that had compiled in 15000 would be visibly wrong here.
      for (const ping of pings()) assert.equal(ping["intervalMs"], TEST_PING_MS);
      assert.notEqual(TEST_PING_MS, PING_INTERVAL_MS);
    } finally {
      socket.close();
    }
  });

  void test("does not spend the receiving tab's frame budget", async () => {
    // The starvation direction: the per-socket budget counts frames RECEIVED from a client, so
    // heartbeats going the other way must leave a user's typing allowance untouched. Were they
    // counted, a tab that had been open for a second would arrive at the keyboard already short.
    const client = await attach(port, "live");
    try {
      const pings = (): number => client.frames.filter((frame) => frame["t"] === "ping").length;
      assert.ok(await waitFor(() => pings() >= 2, TEST_PING_MS * 8), "no heartbeats arrived");

      input.length = 0;
      client.frames.length = 0;
      // One short of the full allowance, because the `attach` above may still be inside this
      // window and is a frame the client really did send. The two-plus heartbeats are the only
      // thing that could take it over.
      const sent = MAX_FRAMES_PER_WINDOW - 1;
      for (let i = 0; i < sent; i++) {
        client.socket.send(JSON.stringify({ t: "input", sessionId: "live", data: "x" }));
      }
      assert.ok(
        await waitFor(() => input.length === sent, 2000),
        `only ${String(input.length)} of ${String(sent)} frames were accepted`,
      );
      assert.deepEqual(
        errorsOf(client),
        [],
        "the heartbeat pushed a legitimate tab over its budget",
      );
    } finally {
      client.socket.close();
    }
  });
});
