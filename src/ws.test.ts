import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { WebSocket } from "ws";

import { PANE_COLS } from "./protocol.ts";
import type { Session } from "./registry.ts";
import { SessionStream } from "./stream.ts";
import { attachWebSocketServer, type WsDeps } from "./ws.ts";

const TOKEN = "ws-test-token";
const ORIGIN = "https://mac.example.ts.net";

let server: Server;
let url: string;
let closeWs: () => void;
let stream: SessionStream;
const input: string[] = [];
const rowsApplied: number[] = [];

before(async () => {
  stream = new SessionStream({ sessionId: "s1" });
  server = createServer();
  closeWs = attachWebSocketServer(server, {
    token: TOKEN,
    origin: ORIGIN,
    streamFor: (id) => (id === "s1" ? stream : undefined),
    listSessions: async () => await Promise.resolve([]),
    captureHistory: async () => await Promise.resolve("scrollback\n"),
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint: async () =>
      await Promise.resolve({ data: "repainted screen", seq: stream.buffer.headSeq }),
    sendInput: (_id, data) => input.push(data),
    applyPaneRows: (_id, rows) => rowsApplied.push(rows),
  }).close;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  closeWs();
  server.close();
});

type Frame = Record<string, unknown>;

/**
 * A socket with every frame queued from the moment it opens: `once("message")` per read loses what
 * arrives between reads, and the server sends snapshot and state back to back.
 */
interface Client {
  socket: WebSocket;
  next: (timeoutMs?: number) => Promise<Frame>;
  take: (count: number) => Promise<Frame[]>;
}

const open = async (
  protocols: string | string[] = TOKEN,
  target = url,
  // Every socket gets the pane width and then the session list on open. Neither is what the tests
  // below read, so both are dropped here rather than skipped past in each of them.
  keepBaseline = false,
): Promise<Client> => {
  const socket = new WebSocket(target, protocols, { origin: ORIGIN });
  const queue: Frame[] = [];
  let notify: (() => void) | undefined;

  socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as Frame;
    if (!keepBaseline && (frame["t"] === "sessions" || frame["t"] === "hello")) return;
    queue.push(frame);
    notify?.();
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const next = async (timeoutMs = 2000): Promise<Frame> => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    return await new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined;
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      notify = () => {
        clearTimeout(timer);
        notify = undefined;
        const frame = queue.shift();
        if (frame === undefined) reject(new Error("notified with an empty queue"));
        else resolve(frame);
      };
    });
  };

  const take = async (count: number): Promise<Frame[]> => {
    const out: Frame[] = [];
    while (out.length < count) out.push(await next());
    return out;
  };

  return { socket, next, take };
};

/**
 * A second server of the same shape but with its own `repaint`: the three describes below each need
 * a build they can fail or count, which the shared server cannot offer.
 */
const privateServer = async (
  ownStream: SessionStream,
  repaint: WsDeps["repaint"],
): Promise<{ url: string; close: () => void }> => {
  const own = createServer();
  const closeOwn = attachWebSocketServer(own, {
    token: TOKEN,
    origin: ORIGIN,
    streamFor: (id) => (id === "s1" ? ownStream : undefined),
    listSessions: async () => await Promise.resolve([]),
    captureHistory: async () => await Promise.resolve("scrollback\n"),
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint,
    sendInput: () => undefined,
    applyPaneRows: () => undefined,
  }).close;
  await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
  return {
    url: `ws://127.0.0.1:${String((own.address() as AddressInfo).port)}`,
    close: () => {
      closeOwn();
      own.close();
    },
  };
};

void describe("the upgrade is authenticated before a socket exists", () => {
  void test("a valid token opens, and the subprotocol is echoed back", async () => {
    // The echo is not decoration: without it the browser closes the connection below any code of
    // ours, presenting as "the socket will not open" with nothing logged.
    const client = await open();
    assert.equal(client.socket.protocol, TOKEN, "the server must echo the selected subprotocol");
    client.socket.close();
  });

  void test("a wrong token is refused at the handshake", async () => {
    await assert.rejects(async () => await open("not-the-token"));
  });

  void test("no token at all is refused", async () => {
    await assert.rejects(
      async () =>
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(url, { origin: ORIGIN });
          socket.once("open", () => {
            socket.close();
            resolve();
          });
          socket.once("error", reject);
        }),
    );
  });

  void test("a foreign Origin is refused", async () => {
    await assert.rejects(
      async () =>
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(url, TOKEN, { origin: "https://evil.example" });
          socket.once("open", () => {
            socket.close();
            resolve();
          });
          socket.once("error", reject);
        }),
    );
  });
});

void describe("attach", () => {
  void test("a first attach gets a snapshot with scrollback, then a state", async () => {
    stream.write(Buffer.from("live bytes"));
    const client = await open();
    client.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));

    const [snapshot, state] = await client.take(2);
    assert.equal(snapshot?.["t"], "snapshot");
    assert.equal(snapshot?.["history"], "scrollback\n");
    // The live screen is the repaint, not the ring buffer: "live bytes" is what happened to be
    // recent, which for a session idle at a prompt is not what the screen shows.
    assert.equal(snapshot?.["data"], "repainted screen");
    assert.equal(snapshot?.["epoch"], stream.epoch);
    assert.equal(state?.["t"], "state");
    client.socket.close();
  });

  void test("a covered client gets chunks rather than a repaint", async () => {
    const client = await open();
    const at = stream.buffer.headSeq;
    stream.write(Buffer.from("after"));
    client.socket.send(
      JSON.stringify({
        t: "attach",
        sessionId: "s1",
        cols: 80,
        rows: 24,
        haveEpoch: stream.epoch,
        haveSeq: at,
      }),
    );
    const first = await client.next();
    assert.equal(first["t"], "chunk");
    assert.equal(first["data"], "after");
    client.socket.close();
  });

  void test("a stale epoch gets a snapshot even with a plausible seq", async () => {
    const client = await open();
    client.socket.send(
      JSON.stringify({
        t: "attach",
        sessionId: "s1",
        cols: 80,
        rows: 24,
        haveEpoch: "from-a-previous-process",
        haveSeq: 1,
      }),
    );
    const first = await client.next();
    assert.equal(first["t"], "snapshot", "chunks here would leave the tab permanently blank");
    client.socket.close();
  });

  void test("live output reaches an attached client", async () => {
    const client = await open();
    client.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    await client.take(2);

    stream.write(Buffer.from("streamed"));
    const chunk = await client.next();
    assert.equal(chunk["t"], "chunk");
    assert.equal(chunk["data"], "streamed");
    client.socket.close();
  });
});

void describe("input and resize", () => {
  void test("input goes to the PTY and is never echoed back specially", async () => {
    const client = await open();
    client.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    await client.take(2);

    const before = input.length;
    client.socket.send(JSON.stringify({ t: "input", sessionId: "s1", data: "ls\r" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(input[before], "ls\r");
    client.socket.close();
  });

  void test("the pane is sized to the shortest attached client, and its cols are ignored", async () => {
    const tall = await open();
    tall.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 200, rows: 50 }));
    await tall.take(2);

    const short = await open();
    short.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 60, rows: 20 }));
    await short.take(2);

    assert.equal(rowsApplied.at(-1), 20, "the shorter client must win");

    // Detaching the short one lets the pane grow back.
    short.socket.close();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(rowsApplied.at(-1), 50);
    tall.socket.close();
  });
});

void describe("refusals", () => {
  void test("a malformed frame is an error message, not a dropped socket", async () => {
    const client = await open();
    client.socket.send("{not json");
    const message = await client.next();
    assert.equal(message["t"], "error");
    assert.match(String(message["message"]), /not JSON/);
    assert.equal(client.socket.readyState, client.socket.OPEN, "the socket should survive it");
    client.socket.close();
  });

  void test("an unknown session is named in the error", async () => {
    const client = await open();
    client.socket.send(JSON.stringify({ t: "attach", sessionId: "nope", cols: 80, rows: 24 }));
    const message = await client.next();
    assert.equal(message["t"], "error");
    assert.match(String(message["message"]), /nope/);
    client.socket.close();
  });

  void test("a bad resize is refused without touching the pane", async () => {
    const client = await open();
    const before = rowsApplied.length;
    client.socket.send(JSON.stringify({ t: "resize", sessionId: "s1", cols: -5, rows: 24 }));
    const message = await client.next();
    assert.equal(message["t"], "error");
    assert.equal(rowsApplied.length, before);
    client.socket.close();
  });
});

// ---------------------------------------------------------------------------------------------

// Three tests about the cold snapshot on the wire, each needing its own server because it varies a
// dep the shared fixture fixes. One helper, since they differ only in which source they replace.
type SnapshotDeps = Pick<WsDeps, "captureHistory" | "isAlternateScreen" | "repaint">;

const ownServer = async (overrides: Partial<SnapshotDeps & Pick<WsDeps, "snapshotTimeoutMs">>) => {
  const own = createServer();
  const ownStream = new SessionStream({ sessionId: "s1" });
  const close = attachWebSocketServer(own, {
    token: TOKEN,
    origin: ORIGIN,
    streamFor: (id) => (id === "s1" ? ownStream : undefined),
    listSessions: async () => await Promise.resolve([]),
    captureHistory: async () => await Promise.resolve("what vim currently looks like\n"),
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint: async () => await Promise.resolve({ data: "", seq: ownStream.buffer.headSeq }),
    sendInput: () => undefined,
    applyPaneRows: () => undefined,
    ...overrides,
  }).close;
  await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
  const ownUrl = `ws://127.0.0.1:${String((own.address() as AddressInfo).port)}`;
  const socket = new WebSocket(ownUrl, TOKEN, { origin: ORIGIN });
  const frames: Frame[] = [];
  socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as Frame;
    // The open-time baseline, dropped for the same reason as in `open` above.
    if (frame["t"] !== "sessions" && frame["t"] !== "hello") frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  // A second phone on the SAME server: a per-session cache that wedges is a defect other clients
  // inherit, so a test for it needs a client that arrives after the first one broke.
  const extras: WebSocket[] = [];
  const connect = async () => {
    const other = new WebSocket(ownUrl, TOKEN, { origin: ORIGIN });
    const otherFrames: Frame[] = [];
    other.on("message", (raw: Buffer) =>
      otherFrames.push(JSON.parse(raw.toString("utf8")) as Frame),
    );
    await new Promise<void>((resolve, reject) => {
      other.once("open", resolve);
      other.once("error", reject);
    });
    extras.push(other);
    return {
      socket: other,
      frames: otherFrames,
      attach: () =>
        other.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 })),
    };
  };

  return {
    socket,
    frames,
    stream: ownStream,
    connect,
    attach: () => socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 })),
    stop: () => {
      for (const extra of extras) extra.close();
      socket.close();
      close();
      own.close();
    },
  };
};

// The frame the client actually receives, for the two shapes `buildSnapshot` alone cannot show:
// `history` ABSENT rather than empty, and a failed repaint costing one message rather than the process.
void describe("the snapshot frame on the wire", () => {
  void test("in alternate-screen mode the frame carries no history key at all", async () => {
    // `"history" in frame` rather than a value comparison: an empty string is a blank line written
    // above the live screen, and on the alternate screen it would be the TUI's own frame.
    const tui = await ownServer({
      isAlternateScreen: async () => await Promise.resolve(true),
      repaint: async () => await Promise.resolve({ data: "vim, repainted", seq: 7 }),
    });
    tui.attach();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const snapshot = tui.frames.find((frame) => frame["t"] === "snapshot");
    assert.ok(snapshot, "no snapshot was sent");
    assert.equal("history" in snapshot, false, "the TUI's frame was sent as scrollback");
    assert.equal(snapshot["data"], "vim, repainted");
    tui.stop();
  });

  void test("a failing repaint costs one message, not the process", async () => {
    // `Tmux.repaint` throws with no client attached, and the ws message handler is fire-and-forget:
    // an unhandled rejection exits Node, on a process nothing restarts.
    const failing = await ownServer({
      repaint: async () => {
        await Promise.resolve();
        throw new Error("no tmux client is attached to s1, so it cannot repaint");
      },
    });
    failing.attach();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(failing.frames.at(-1)?.["t"], "error", "the client was never told");
    assert.equal(failing.socket.readyState, failing.socket.OPEN, "the socket did not survive it");
    failing.stop();
  });
});

// The snapshot path reaches capture-pane and `Tmux` rethrows, so a discarded promise made one
// failing capture an unhandled rejection. One phone's message must not cost every phone its socket.
void describe("a failing capture costs one message, not the process", () => {
  void test("the client is told, the socket lives, and the process does not exit", async () => {
    const failing = await ownServer({
      captureHistory: async () => {
        await Promise.resolve();
        throw new Error("stdout maxBuffer length exceeded");
      },
    });
    failing.attach();
    // Long enough that an unhandled rejection would have taken the runner down by now.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      failing.frames.at(-1)?.["t"],
      "error",
      "the client was never told the capture failed",
    );
    assert.equal(
      failing.socket.readyState,
      failing.socket.OPEN,
      "the socket did not survive the failure",
    );
    failing.stop();
  });
});

// ---------------------------------------------------------------------------------------------

// Coalescing makes one build's fate every caller's, so both ways a build ends badly - never
// settling, and failing - must leave the session usable for the next phone.
void describe("a bad snapshot build is not inherited by the next client", () => {
  void test("a capture that never returns is abandoned, and the next attach builds its own", async () => {
    // A tmux that stops answering is a capture-pane that never returns, and evicting only in
    // `.finally()` pinned the entry forever - every later attach joined the dead build.
    let calls = 0;
    const wedged = await ownServer({
      snapshotTimeoutMs: 150,
      captureHistory: async () => {
        calls += 1;
        if (calls === 1) return await new Promise<string>(() => undefined);
        return await Promise.resolve("healthy scrollback\n");
      },
    });
    wedged.attach();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(wedged.frames.at(-1)?.["t"], "error", "the hung build was never bounded");

    const second = await wedged.connect();
    second.attach();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snapshot = second.frames.find((frame) => frame["t"] === "snapshot");
    assert.ok(snapshot, "a fresh client inherited the wedged build instead of making its own");
    assert.equal(snapshot["history"], "healthy scrollback\n");
    wedged.stop();
  });

  void test("a failed snapshot detaches, so a retry gets a listener that forwards", async () => {
    // The listener queues until the snapshot is away, so a failed snapshot left it registered and
    // draining into nothing - and a retry found `client.attached` already set.
    let calls = 0;
    const failing = await ownServer({
      captureHistory: async () => {
        calls += 1;
        if (calls === 1) {
          await Promise.resolve();
          throw new Error("stdout maxBuffer length exceeded");
        }
        return await Promise.resolve("healthy scrollback\n");
      },
    });
    failing.attach();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(failing.frames.at(-1)?.["t"], "error");

    failing.frames.length = 0;
    failing.attach();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      failing.frames.some((frame) => frame["t"] === "snapshot"),
      "the retry got no snapshot",
    );

    failing.stream.write(Buffer.from("after the retry"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const chunks = failing.frames.filter((frame) => frame["t"] === "chunk");
    assert.equal(
      chunks.filter((frame) => String(frame["data"]).includes("after the retry")).length,
      1,
      "the client is silently blind: the poisoned listener swallowed the bytes",
    );
    failing.stop();
  });
});

// ---------------------------------------------------------------------------------------------

// The repaint's bytes come back through the same stream the listener is on, so sending before the
// snapshot gives a positionless client chunks - which it answers with a second full snapshot.
void describe("a cold attach is told where it is before it is told what changed", () => {
  const ordStream = new SessionStream({ sessionId: "s1" });
  let ordUrl: string;
  let ordClose: () => void;

  before(async () => {
    // What a real repaint does: write into the stream the client is attached to, then report the
    // seq those bytes ended at.
    ({ url: ordUrl, close: ordClose } = await privateServer(ordStream, async () => {
      ordStream.write(Buffer.from("REPAINT-BYTES"));
      await Promise.resolve();
      return { data: "REPAINT-BYTES", seq: ordStream.buffer.headSeq };
    }));
  });

  after(() => {
    ordClose();
  });

  void test("no chunk arrives before the snapshot", async () => {
    const socket = new WebSocket(ordUrl, TOKEN, { origin: ORIGIN });
    const frames: Frame[] = [];
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Frame;
      // The open-time baseline, dropped for the same reason as in `open` above.
      if (frame["t"] !== "sessions" && frame["t"] !== "hello") frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const firstSnapshot = frames.findIndex((frame) => frame["t"] === "snapshot");
    assert.notEqual(firstSnapshot, -1, "no snapshot arrived at all");
    assert.equal(
      frames.slice(0, firstSnapshot).filter((frame) => frame["t"] === "chunk").length,
      0,
      "a chunk was sent to a client that had no position yet, which makes it resync",
    );
    // And the repaint's own bytes are not then replayed on top of the snapshot that contains them.
    const after = frames.slice(firstSnapshot + 1).filter((frame) => frame["t"] === "chunk");
    assert.equal(
      after.filter((frame) => String(frame["data"]).includes("REPAINT-BYTES")).length,
      0,
      "the repaint's bytes were painted twice",
    );
    socket.close();
  });
});

// ---------------------------------------------------------------------------------------------

// Sharing the SUCCESS is the point; sharing the FAILURE let one client's flood detach whoever
// attached beside it - on a socket that stays OPEN, so nothing tells it to try again.
void describe("one client's failed snapshot does not detach another", () => {
  const shStream = new SessionStream({ sessionId: "s1" });
  let shUrl: string;
  let shClose: () => void;
  let attempts = 0;

  before(async () => {
    // The first build fails the way a real one does; later ones succeed, so a caller that makes its
    // own attempt gets a snapshot rather than inheriting the first caller's exception.
    ({ url: shUrl, close: shClose } = await privateServer(shStream, async () => {
      attempts += 1;
      await Promise.resolve();
      if (attempts === 1) throw new Error("stdout maxBuffer length exceeded");
      return { data: "repainted", seq: shStream.buffer.headSeq };
    }));
  });

  after(() => {
    shClose();
  });

  void test("the second client still gets its snapshot and stays attached", async () => {
    const sockets = [
      new WebSocket(shUrl, TOKEN, { origin: ORIGIN }),
      new WebSocket(shUrl, TOKEN, { origin: ORIGIN }),
    ];
    const seen: Frame[][] = [[], []];
    sockets.forEach((socket, index) => {
      socket.on("message", (raw: Buffer) => {
        seen[index]?.push(JSON.parse(raw.toString("utf8")) as Frame);
      });
    });
    await Promise.all(
      sockets.map(
        async (socket) =>
          await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
      ),
    );

    // Both attach inside one in-flight window, so the second joins the first's build.
    for (const socket of sockets) {
      socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    const gotSnapshot = seen.filter((frames) => frames.some((f) => f["t"] === "snapshot")).length;
    assert.ok(
      gotSnapshot >= 1,
      "neither client got a snapshot: the shared failure took both of them down",
    );
    assert.ok(
      shStream.clients.size >= 1,
      "a failed build detached every client, leaving open sockets with no listener",
    );
    for (const socket of sockets) socket.close();
  });
});

// ---------------------------------------------------------------------------------------------

// Jitter spreads a burst rather than stopping one, and each re-attach is a cold snapshot - so
// coalescing keeps N of those from being N builds, including through a FAILED one.
void describe("a reconnect storm is not a spawn storm", () => {
  const stStream = new SessionStream({ sessionId: "s1" });
  let stUrl: string;
  let stClose: () => void;
  let builds = 0;
  let failFirst = true;

  before(async () => {
    ({ url: stUrl, close: stClose } = await privateServer(stStream, async () => {
      builds += 1;
      // A real build is several process spawns and does not settle in the same tick, which is what
      // gives a storm the window to pile onto it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (failFirst && builds === 1) throw new Error("stdout maxBuffer length exceeded");
      return { data: "repainted", seq: stStream.buffer.headSeq };
    }));
  });

  after(() => {
    stClose();
  });

  /** Open `count` sockets, attach them all to s1 at once, and answer what each one received. */
  const storm = async (count: number): Promise<Frame[][]> => {
    const sockets = Array.from(
      { length: count },
      () => new WebSocket(stUrl, TOKEN, { origin: ORIGIN }),
    );
    const seen: Frame[][] = sockets.map(() => []);
    sockets.forEach((socket, index) => {
      socket.on("message", (raw: Buffer) => {
        seen[index]?.push(JSON.parse(raw.toString("utf8")) as Frame);
      });
    });
    await Promise.all(
      sockets.map(
        async (socket) =>
          await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
      ),
    );
    for (const socket of sockets) {
      socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (const socket of sockets) socket.close();
    return seen;
  };

  void test("a build that fails under a storm is retried once, not once per client", async () => {
    const seen = await storm(8);
    assert.equal(builds, 2, `eight re-attaches cost ${String(builds)} snapshot builds`);
    // The retry is not a consolation prize for whoever started it: every joiner of the failed build
    // gets the successful one, and only the client whose own build failed is detached.
    assert.equal(
      seen.filter((frames) => frames.some((frame) => frame["t"] === "snapshot")).length,
      7,
      "a client that joined the failed build was left with no snapshot and an open socket",
    );
    assert.equal(
      seen.filter((frames) => frames.some((frame) => frame["t"] === "error")).length,
      1,
      "the failure was reported to more than the one client that met it",
    );
  });

  void test("two tabs of one session reconnecting together share a single build", async () => {
    failFirst = false;
    builds = 0;
    const seen = await storm(2);
    assert.equal(builds, 1, "each tab paid for its own capture-pane");
    assert.equal(
      seen.filter((frames) => frames.some((frame) => frame["t"] === "snapshot")).length,
      2,
      "one of the two tabs was left blank",
    );
  });
});

// ---------------------------------------------------------------------------------------------

// What one `attach` may hold, and for how long: the queue's size is whatever the session printed
// while the build ran, and the build's own bound is fifteen seconds against a wedged tmux.
void describe("an attach cannot hold the session's whole output while it waits", () => {
  // Assigned before the attach that triggers the repaint below, which is the only thing that
  // reads it.
  let noisyStream: SessionStream | undefined;
  void test("a flood during the build is dropped and answered from the ring buffer", async () => {
    const noisy = await ownServer({
      repaint: async () => {
        // The screen the repaint describes is the one at THIS position; the flood below arrives
        // after it, which is what leaves the queue with real work to flush.
        const target = noisyStream;
        assert.ok(target, "the repaint ran before the stream was known");
        const seq = target.buffer.headSeq;
        for (let index = 0; index < 60; index += 1) {
          target.write(Buffer.alloc(100 * 1024, "x"));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { data: "repainted", seq };
      },
    });
    noisyStream = noisy.stream;
    noisy.attach();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const bytes = noisy.frames
      .filter((frame) => frame["t"] === "chunk" || frame["t"] === "snapshot")
      .reduce((total, frame) => total + (frame["data"] as string).length, 0);
    // The ring buffer is 256 KB. Anything near the 6 MB written is the queue, retained in full.
    assert.ok(
      bytes < 1024 * 1024,
      `the attach held ${String(bytes)} bytes of output instead of dropping to the ring buffer`,
    );
    // Dropping must not mean going silent: the client is still caught up.
    assert.ok(
      noisy.frames.some(
        (frame) =>
          (frame["t"] === "snapshot" || frame["t"] === "chunk") &&
          String(frame["data"]).includes("x"),
      ),
      "the client was left with a hole where the flood was",
    );
    noisy.stop();
  });
});

// The other bound on the same window: how many OTHER clients' failed builds one attach waits out.
// Each is up to a whole timeout, so an unbounded chain is an unbounded park.
void describe("one attach cannot be parked behind every other attach's failure", () => {
  void test("a storm where every build fails still settles in a bounded number of builds", async () => {
    const stormStream = new SessionStream({ sessionId: "s1" });
    const { url: sUrl, close: sClose } = await privateServer(stormStream, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      throw new Error("stdout maxBuffer length exceeded");
    });
    const sockets = Array.from({ length: 8 }, () => new WebSocket(sUrl, TOKEN, { origin: ORIGIN }));
    const errors: number[] = [];
    await Promise.all(
      sockets.map(
        async (socket) =>
          await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
      ),
    );
    const started = Date.now();
    for (const socket of sockets) {
      socket.on("message", (raw: Buffer) => {
        if ((JSON.parse(raw.toString("utf8")) as Frame)["t"] === "error") {
          errors.push(Date.now() - started);
        }
      });
      socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const socket of sockets) socket.close();
    sClose();

    assert.equal(errors.length, 8, "not every client was told its snapshot failed");
    const last = Math.max(...errors);
    // Three builds is the bound - two inherited failures plus your own. Chaining one per client
    // would be eight, which at the real timeout is two minutes parked holding a queue.
    assert.ok(
      last < 500,
      `the last client was parked ${String(last)}ms, which is one build per client`,
    );
  });
});

// A state frame is the strip's only source of a status change, so who receives one decides whether
// it can be right about a session nobody is looking at (plan 002).
void describe("a state change goes to every open socket, not only the attached ones", () => {
  let own: Server;
  let ownUrl: string;
  let handle: ReturnType<typeof attachWebSocketServer>;

  before(async () => {
    const s1 = new SessionStream({ sessionId: "s1" });
    own = createServer();
    handle = attachWebSocketServer(own, {
      token: TOKEN,
      origin: ORIGIN,
      streamFor: (id) => (id === "s1" ? s1 : undefined),
      listSessions: async () => await Promise.resolve([]),
      captureHistory: async () => await Promise.resolve("scrollback\n"),
      isAlternateScreen: async () => await Promise.resolve(false),
      repaint: async () => await Promise.resolve({ data: "", seq: s1.buffer.headSeq }),
      sendInput: () => undefined,
      applyPaneRows: () => undefined,
    });
    await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
    ownUrl = `ws://127.0.0.1:${String((own.address() as AddressInfo).port)}`;
  });

  after(() => {
    handle.close();
    own.close();
  });

  void test("a socket that has attached nothing is still told", async () => {
    // The strip's own socket. It attached to no session at all, which is exactly the client this
    // item is about: one tab is open in the terminal pane and the other two are rows in a strip.
    const client = await open(TOKEN, ownUrl);
    handle.pushState("s2", "waiting");
    assert.deepEqual(await client.next(), { t: "state", sessionId: "s2", state: "waiting" });
    client.socket.close();
  });

  void test("a socket attached to one session hears about another", async () => {
    const client = await open(TOKEN, ownUrl);
    client.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    // snapshot, then the state answering the attach.
    await client.take(2);

    handle.pushState("s2", "waiting");
    assert.deepEqual(await client.next(), { t: "state", sessionId: "s2", state: "waiting" });
    client.socket.close();
  });

  void test("every open socket gets it, so a second phone is not left behind", async () => {
    const clients = await Promise.all([open(TOKEN, ownUrl), open(TOKEN, ownUrl)]);
    handle.pushState("s3", "working");
    for (const client of clients) {
      assert.deepEqual(await client.next(), { t: "state", sessionId: "s3", state: "working" });
    }
    for (const client of clients) client.socket.close();
  });

  void test("an exit carries its code, and a state without one does not invent it", async () => {
    // `exited 1` is an answer to "did it finish or did I lose it", and the absent field must stay
    // absent rather than becoming a 0 the strip would render as a clean exit.
    const client = await open(TOKEN, ownUrl);
    handle.pushState("s2", "exited", 137);
    assert.deepEqual(await client.next(), {
      t: "state",
      sessionId: "s2",
      state: "exited",
      exitCode: 137,
    });
    handle.pushState("s2", "idle");
    assert.deepEqual(await client.next(), { t: "state", sessionId: "s2", state: "idle" });
    client.socket.close();
  });

  void test("a closed socket is not written to", async () => {
    const client = await open(TOKEN, ownUrl);
    await new Promise<void>((done) => {
      client.socket.once("close", () => done());
      client.socket.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A push after every client has gone must be a no-op rather than a throw out of the hub's
    // sync, which is a timer callback with nothing above it to catch.
    assert.doesNotThrow(() => handle.pushState("s2", "waiting"));
  });
});

// The other half of "pushed, not polled": a push reaches only the sockets open at the time, and the
// dedupe is server-wide - so a dropped phone missed every transition, permanently.
void describe("a socket is given the session list the moment it opens", () => {
  let own: Server;
  let ownUrl: string;
  let handle: ReturnType<typeof attachWebSocketServer>;
  const listed: Session[] = [
    {
      id: "s1",
      name: "s1",
      cwd: "/workspace/a",
      agent: "claude",
      state: "waiting",
      startedAt: 1,
    },
  ];

  before(async () => {
    const s1 = new SessionStream({ sessionId: "s1" });
    own = createServer();
    handle = attachWebSocketServer(own, {
      token: TOKEN,
      origin: ORIGIN,
      streamFor: (id) => (id === "s1" ? s1 : undefined),
      listSessions: async () => await Promise.resolve(listed),
      captureHistory: async () => await Promise.resolve("scrollback\n"),
      isAlternateScreen: async () => await Promise.resolve(false),
      repaint: async () => await Promise.resolve({ data: "", seq: s1.buffer.headSeq }),
      sendInput: () => undefined,
      applyPaneRows: () => undefined,
    });
    await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
    ownUrl = `ws://127.0.0.1:${String((own.address() as AddressInfo).port)}`;
  });

  after(() => {
    handle.close();
    own.close();
  });

  void test("a reconnecting socket that attaches nothing is still told which one needs you", async () => {
    // The tab for s1 was never opened, so the ladder sends no `attach` and no state frame follows -
    // and its move to `waiting` was announced while this socket was down.
    const client = await open(TOKEN, ownUrl, true);
    const [hello, sessions] = await client.take(2);
    assert.equal(hello?.["t"], "hello");
    assert.deepEqual(sessions, { t: "sessions", sessions: listed });
    client.socket.close();
  });

  void test("every socket is told the width the panes are actually wrapped to", async () => {
    // The client's own PANE_COLS is compiled into a bundle rebuilt separately from this process, so
    // the skew read as padding on the phone. The width is this server's fact, so it states it.
    const client = await open(TOKEN, ownUrl, true);
    assert.deepEqual(await client.next(), { t: "hello", cols: PANE_COLS });
    client.socket.close();
  });

  void test("the width does not depend on the session list, which is allowed to fail", async () => {
    // `sessions` is built from tmux and can reject, so folding the width into that frame would make
    // one failing capture cost the client its width - a blank pane from an unrelated fault.
    const broken = createServer();
    const brokenHandle = attachWebSocketServer(broken, {
      token: TOKEN,
      origin: ORIGIN,
      streamFor: () => undefined,
      listSessions: () => Promise.reject(new Error("tmux did not answer")),
      captureHistory: async () => await Promise.resolve(""),
      isAlternateScreen: async () => await Promise.resolve(false),
      repaint: async () => await Promise.resolve({ data: "", seq: 0 }),
      sendInput: () => undefined,
      applyPaneRows: () => undefined,
    });
    await new Promise<void>((done) => broken.listen(0, "127.0.0.1", done));
    const brokenUrl = `ws://127.0.0.1:${String((broken.address() as AddressInfo).port)}`;
    try {
      const client = await open(TOKEN, brokenUrl, true);
      assert.deepEqual(await client.next(), { t: "hello", cols: PANE_COLS });
      client.socket.close();
    } finally {
      brokenHandle.close();
      broken.close();
    }
  });
});
