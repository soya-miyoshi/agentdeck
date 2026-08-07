import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { WebSocket } from "ws";

import { SessionStream } from "./stream.ts";
import { attachWebSocketServer } from "./ws.ts";

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

// The snapshot path reaches capture-pane, and `Tmux` rethrows anything that is not a missing
// session or an empty server. `socket.on("message")` discarded the promise, so one failing capture
// was an unhandled rejection - which exits Node, on a process nothing restarts (see
// src/supervisor-crash.test.ts). A capture big enough to pass execFile's buffer is the ordinary
// way to trigger it: 2000 lines of `capture-pane -e` is agent-sized output, and a session that
// wants to can produce it deliberately. One phone's message must not cost every phone its socket.
void describe("a failing capture costs one message, not the process", () => {
  let failServer: ReturnType<typeof createServer>;
  let failClose: () => void;
  let failUrl: string;
  const failStream = new SessionStream({ sessionId: "s1" });

  before(async () => {
    failServer = createServer();
    failClose = attachWebSocketServer(failServer, {
      token: TOKEN,
      origin: ORIGIN,
      streamFor: (id) => (id === "s1" ? failStream : undefined),
      captureHistory: async () => {
        await Promise.resolve();
        throw new Error("stdout maxBuffer length exceeded");
      },
      isAlternateScreen: async () => await Promise.resolve(false),
      repaint: async () => await Promise.resolve({ data: "", seq: failStream.buffer.headSeq }),
      sendInput: () => undefined,
      applyPaneSize: () => undefined,
    }).close;
    await new Promise<void>((done) => failServer.listen(0, "127.0.0.1", done));
    failUrl = `ws://127.0.0.1:${String((failServer.address() as AddressInfo).port)}`;
  });

  after(() => {
    failClose();
    failServer.close();
  });

  void test("the client is told, the socket lives, and the process does not exit", async () => {
    const socket = new WebSocket(failUrl, TOKEN, { origin: ORIGIN });
    const frames: Frame[] = [];
    socket.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString("utf8")) as Frame));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.send(JSON.stringify({ t: "attach", sessionId: "s1", cols: 80, rows: 24 }));
    // Long enough that an unhandled rejection would have taken the runner down by now.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(frames.at(-1)?.["t"], "error", "the client was never told the capture failed");
    assert.equal(socket.readyState, socket.OPEN, "the socket did not survive the failure");
    socket.close();
  });
});
