import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { WebSocket } from "ws";

import { SessionStream } from "./stream.ts";
import { attachWebSocketServer, type WsDeps } from "./ws.ts";

const TOKEN = "ws-test-token";
const ORIGIN = "https://mac.example.ts.net";

let server: Server;
let url: string;
let closeWs: () => void;
let stream: SessionStream;
const input: string[] = [];
const sizes: { cols: number; rows: number }[] = [];

before(async () => {
  stream = new SessionStream({ sessionId: "s1" });
  server = createServer();
  closeWs = attachWebSocketServer(server, {
    token: TOKEN,
    origin: ORIGIN,
    streamFor: (id) => (id === "s1" ? stream : undefined),
    captureHistory: async () => await Promise.resolve("scrollback\n"),
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint: async () =>
      await Promise.resolve({ data: "repainted screen", seq: stream.buffer.headSeq }),
    sendInput: (_id, data) => input.push(data),
    applyPaneSize: (_id, cols, rows) => sizes.push({ cols, rows }),
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
 * A socket with every frame queued from the moment it opens.
 *
 * Registering `once("message")` per read loses anything that arrives between reads - the server
 * sends snapshot and state back to back, so the second was dropped and the test hung forever
 * waiting for a message it had already been sent.
 */
interface Client {
  socket: WebSocket;
  next: (timeoutMs?: number) => Promise<Frame>;
  take: (count: number) => Promise<Frame[]>;
}

const open = async (protocols: string | string[] = TOKEN): Promise<Client> => {
  const socket = new WebSocket(url, protocols, { origin: ORIGIN });
  const queue: Frame[] = [];
  let notify: (() => void) | undefined;

  socket.on("message", (raw: Buffer) => {
    queue.push(JSON.parse(raw.toString("utf8")) as Frame);
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

void describe("the upgrade is authenticated before a socket exists", () => {
  void test("a valid token opens, and the subprotocol is echoed back", async () => {
    // The echo is not decoration: without it the browser closes the connection at the socket
    // layer, before any of our code runs, and it presents as "the socket just will not open"
    // with nothing logged.
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

  void test("the pane is sized to the minimum over attached clients", async () => {
    const wide = await open();
    wide.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 200, rows: 50 }));
    await wide.take(2);

    const narrow = await open();
    narrow.socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 60, rows: 20 }));
    await narrow.take(2);

    assert.deepEqual(sizes.at(-1), { cols: 60, rows: 20 }, "the narrower client must win");

    // Detaching the small one lets the pane grow back.
    narrow.socket.close();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(sizes.at(-1), { cols: 200, rows: 50 });
    wide.socket.close();
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
    const before = sizes.length;
    client.socket.send(JSON.stringify({ t: "resize", sessionId: "s1", cols: -5, rows: 24 }));
    const message = await client.next();
    assert.equal(message["t"], "error");
    assert.equal(sizes.length, before);
    client.socket.close();
  });
});

// ---------------------------------------------------------------------------------------------

// The three tests below are about the cold snapshot as it lands on the wire, and each one needs a
// server of its own because what it varies is a dep the shared fixture fixes for every other test
// in this file. One helper for all three: they differ only in which of the three snapshot sources
// they replace, and a second copy of the listen/open/collect dance is where the two halves drift.
type SnapshotDeps = Pick<WsDeps, "captureHistory" | "isAlternateScreen" | "repaint">;

const ownServer = async (overrides: Partial<SnapshotDeps & Pick<WsDeps, "snapshotTimeoutMs">>) => {
  const own = createServer();
  const ownStream = new SessionStream({ sessionId: "s1" });
  const close = attachWebSocketServer(own, {
    token: TOKEN,
    origin: ORIGIN,
    streamFor: (id) => (id === "s1" ? ownStream : undefined),
    captureHistory: async () => await Promise.resolve("what vim currently looks like\n"),
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint: async () => await Promise.resolve({ data: "", seq: ownStream.buffer.headSeq }),
    sendInput: () => undefined,
    applyPaneSize: () => undefined,
    ...overrides,
  }).close;
  await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
  const ownUrl = `ws://127.0.0.1:${String((own.address() as AddressInfo).port)}`;
  const socket = new WebSocket(ownUrl, TOKEN, { origin: ORIGIN });
  const frames: Frame[] = [];
  socket.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString("utf8")) as Frame));
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

// The frame the client actually receives, for the two shapes of a cold snapshot that a test over
// `buildSnapshot` alone cannot see: `history` has to be ABSENT from the JSON rather than present
// and empty, and a repaint that fails has to cost one message rather than the process.
void describe("the snapshot frame on the wire", () => {
  void test("in alternate-screen mode the frame carries no history key at all", async () => {
    // `"history" in frame` rather than a value comparison, because an empty string here is a
    // blank line the client writes above the live screen - and what capture-pane returns on the
    // alternate screen is worse than blank, it is the TUI's own frame.
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
    // The same hazard as the failing capture below, on the second tmux command this path now
    // makes: `Tmux.repaint` throws when no client is attached to the session, and the ws message
    // handler is a fire-and-forget promise. An unhandled rejection exits Node, on a process
    // nothing restarts.
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

// The snapshot path reaches capture-pane, and `Tmux` rethrows anything that is not a missing
// session or an empty server. `socket.on("message")` discarded the promise, so one failing capture
// was an unhandled rejection - which exits Node, on a process nothing restarts (see
// src/supervisor-crash.test.ts). A capture big enough to pass execFile's buffer is the ordinary
// way to trigger it: 2000 lines of `capture-pane -e` is agent-sized output, and a session that
// wants to can produce it deliberately. One phone's message must not cost every phone its socket.
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

// Coalescing snapshots per session means one build's fate is every caller's fate, so both ways a
// build can end badly - never settling, and failing - have to leave the session usable for the
// next phone that attaches.
void describe("a bad snapshot build is not inherited by the next client", () => {
  void test("a capture that never returns is abandoned, and the next attach builds its own", async () => {
    // A tmux server that stops answering is a capture-pane that never returns: Tmux.#exec passes
    // no execFile timeout, and any process on this uid can stop the tmux server. Evicting the map
    // entry only in `.finally()` pinned it forever, and every later attach joined the dead build.
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
    // The forwarding listener queues until the snapshot is away. When the snapshot failed, the
    // queue was never released and the listener stayed registered - so the tab saw nothing ever
    // again, every byte was retained in memory, and a retry found `client.attached` already set
    // and registered nothing.
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

// The repaint's bytes come back through the same stream the forwarding listener is on, so a
// listener that SENDS before the snapshot delivers chunks to a client that has no position yet.
// The client answers those with `resync` (src/client/stream-position.ts), and for any session past
// the buffer's capacity that means a SECOND full snapshot - another capture-pane, another
// refresh-client - on every cold attach, which is the most common path in the product. Observed
// against the real server before the fix: three chunk frames arrived ahead of the snapshot.
void describe("a cold attach is told where it is before it is told what changed", () => {
  let ordServer: ReturnType<typeof createServer>;
  let ordClose: () => void;
  let ordUrl: string;
  let ordStream: SessionStream;

  before(async () => {
    ordStream = new SessionStream({ sessionId: "s1" });
    ordServer = createServer();
    ordClose = attachWebSocketServer(ordServer, {
      token: TOKEN,
      origin: ORIGIN,
      streamFor: (id) => (id === "s1" ? ordStream : undefined),
      captureHistory: async () => await Promise.resolve("scrollback\n"),
      isAlternateScreen: async () => await Promise.resolve(false),
      // What a real repaint does: write into the stream the client is attached to, then report
      // the seq those bytes ended at.
      repaint: async () => {
        ordStream.write(Buffer.from("REPAINT-BYTES"));
        await Promise.resolve();
        return { data: "REPAINT-BYTES", seq: ordStream.buffer.headSeq };
      },
      sendInput: () => undefined,
      applyPaneSize: () => undefined,
    }).close;
    await new Promise<void>((done) => ordServer.listen(0, "127.0.0.1", done));
    ordUrl = `ws://127.0.0.1:${String((ordServer.address() as AddressInfo).port)}`;
  });

  after(() => {
    ordClose();
    ordServer.close();
  });

  void test("no chunk arrives before the snapshot", async () => {
    const socket = new WebSocket(ordUrl, TOKEN, { origin: ORIGIN });
    const frames: Frame[] = [];
    socket.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString("utf8")) as Frame));
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
