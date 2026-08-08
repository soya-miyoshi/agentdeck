import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";

import { WebSocket } from "ws";

import { SessionStream } from "./stream.ts";
import { attachWebSocketServer, MAX_FRAME_BYTES, MAX_FRAMES_PER_WINDOW } from "./ws.ts";

// What ONE badly behaved socket can do to every other socket. The frame budget bounds how many
// frames arrive; these three bound what a frame is allowed to be, and what it is allowed to cost.

const TOKEN = "ws-robustness-token";

let server: Server;
let closeWs: () => void;
let port: number;
const stream = new SessionStream({ sessionId: "s1" });

/** capture-pane stands in for the two spawns a cold snapshot makes. */
let historyCalls = 0;
let historyLive = 0;
let historyPeak = 0;
let releaseHistory: (() => void) | undefined;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200).end("alive");
  });
  closeWs = attachWebSocketServer(server, {
    token: TOKEN,
    origin: undefined,
    streamFor: (id) => (id === "s1" ? stream : undefined),
    listSessions: async () => await Promise.resolve([]),
    captureHistory: async () => {
      historyCalls += 1;
      historyLive += 1;
      historyPeak = Math.max(historyPeak, historyLive);
      // Held open so overlapping callers really do overlap, the way two concurrent execFile spawns
      // would. A snapshot build that resolved instantly could never be caught racing another.
      await new Promise<void>((done) => {
        releaseHistory = done;
      });
      historyLive -= 1;
      return "scrollback\n";
    },
    isAlternateScreen: async () => await Promise.resolve(false),
    repaint: async () => await Promise.resolve({ data: "screen", seq: stream.buffer.headSeq }),
    sendInput: () => undefined,
    applyPaneSize: () => undefined,
  }).close;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  releaseHistory?.();
  closeWs();
  server.close();
});

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

/** The server is still there: an ordinary HTTP request to the same process gets an answer. */
const serverStillAnswers = async (): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("GET /alive HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    let text = "";
    socket.on("data", (bytes: Buffer) => (text += bytes.toString("utf8")));
    socket.on("close", () => resolve(text.includes("200")));
    socket.on("error", () => resolve(false));
  });

/** A real handshake on a raw TCP socket, so frames can be written that `ws` would never produce. */
const rawHandshake = async (): Promise<Socket> => {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((done) => socket.once("connect", done));
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
      `Sec-WebSocket-Protocol: ${TOKEN}\r\n\r\n`,
  );
  await new Promise<void>((resolve, reject) => {
    const onData = (bytes: Buffer): void => {
      const head = bytes.toString("utf8");
      if (head.startsWith("HTTP/1.1 101")) {
        socket.off("data", onData);
        resolve();
      } else reject(new Error(`handshake refused: ${head.split("\r\n")[0] ?? ""}`));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return socket;
};

/** A masked client text frame carrying exactly these payload bytes, valid UTF-8 or not. */
const maskedTextFrame = (payload: Buffer): Buffer => {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.concat([
          Buffer.from([0x81, 0xfe]),
          (() => {
            const len = Buffer.alloc(2);
            len.writeUInt16BE(payload.length);
            return len;
          })(),
        ]);
  return Buffer.concat([header, mask, masked]);
};

void describe("one socket cannot take the server down with it", () => {
  void test("a malformed frame kills that socket and nothing else", async () => {
    const socket = await rawHandshake();
    // Invalid UTF-8 in a text frame. The receiver rejects it before `message` ever fires, so the
    // frame budget cannot see it; `ws` re-emits it as `error` on the WebSocket, and a WebSocket
    // with no `error` listener throws out of the EventEmitter and exits the process.
    socket.write(maskedTextFrame(Buffer.from([0xff, 0xfe, 0xfd])));
    socket.on("error", () => undefined);

    await new Promise<void>((done) => socket.once("close", done));
    assert.ok(await serverStillAnswers(), "the malformed frame took the whole server down");

    // And a new client can still do real work afterwards.
    const client = new WebSocket(`ws://127.0.0.1:${String(port)}`, TOKEN);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.close();
  });

  // Both of the remaining cases fail by never happening - no close, no second capture - so they
  // carry a timeout rather than hanging the run and reporting nothing.
  void test(
    "a frame larger than the byte budget is refused, not buffered",
    { timeout: 5000 },
    async () => {
      assert.equal(MAX_FRAME_BYTES, 64 * 1024);
      const client = new WebSocket(`ws://127.0.0.1:${String(port)}`, TOKEN);
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      client.on("error", () => undefined);
      const closed = new Promise<number>((resolve) => client.once("close", resolve));

      client.send(
        JSON.stringify({ t: "input", sessionId: "s1", data: "x".repeat(MAX_FRAME_BYTES + 1) }),
      );

      // 1009 is "message too big". Without maxPayload the frame is accepted and fully buffered
      // instead, and this close never comes.
      assert.equal(await closed, 1009);
      assert.ok(await serverStillAnswers(), "the oversized frame took the server down");
    },
  );

  void test(
    "a burst of resyncs inside the frame budget makes one snapshot, not one each",
    { timeout: 5000 },
    async () => {
      const client = new WebSocket(`ws://127.0.0.1:${String(port)}`, TOKEN);
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      historyCalls = 0;
      historyPeak = 0;

      // Exactly the budget: every one of these frames is allowed through, so the budget drops
      // nothing and whatever the expensive path costs is what it actually costs.
      for (let i = 0; i < MAX_FRAMES_PER_WINDOW; i++) {
        client.send(
          JSON.stringify({ t: "resync", sessionId: "s1", haveEpoch: "gone", haveSeq: 0 }),
        );
      }

      assert.ok(await waitFor(() => historyCalls > 0, 2000), "no snapshot was built at all");
      // Give every other frame the same chance to start its own capture before measuring.
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        assert.equal(historyPeak, 1, `${String(historyPeak)} concurrent capture-pane spawns`);
        assert.equal(historyCalls, 1);
      } finally {
        releaseHistory?.();
        releaseHistory = undefined;
        client.close();
      }
    },
  );
});
