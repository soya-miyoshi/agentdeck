import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { withClient } from "./static.ts";

// The secret this test tries to steal. It sits OUTSIDE the build directory, and every refusal
// below is checked by reading it and asserting the response does not contain it - so a test that
// passes because the server answered 403 for the wrong reason, or answered the SPA page instead,
// still fails if the bytes ever come back.
const SECRET = "not-the-clients-business-9f2c1a";

let root: string;
let outside: string;
let secretFile: string;
let server: Server;
let port: number;

const api = (
  _req: unknown,
  res: { writeHead: (s: number, h: object) => void; end: (b: string) => void },
): void => {
  const payload = JSON.stringify({ error: "no route" });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(payload);
};

void before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agentdeck-static-"));
  root = join(tmp, "dist", "client");
  outside = join(tmp, "private");
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  secretFile = join(outside, "token");
  writeFileSync(secretFile, SECRET);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=app></div>");
  writeFileSync(join(root, "assets", "index-abc123.js"), "export const a = 1;\n");
  // A symlink planted inside the build output. Nothing in the request path looks suspicious.
  symlinkSync(secretFile, join(root, "leak"));
  symlinkSync(outside, join(root, "assets", "elsewhere"));

  server = createServer(withClient(api as never, root));
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  port = (server.address() as AddressInfo).port;
});

void after(() => {
  server.close();
});

/** A file is streamed, so it arrives chunk-framed; the frames are not part of what was served. */
const dechunk = (raw: string): string => {
  let rest = raw;
  let out = "";
  for (;;) {
    const end = rest.indexOf("\r\n");
    const size = parseInt(rest.slice(0, end), 16);
    if (!(size > 0)) return out;
    out += rest.slice(end + 2, end + 2 + size);
    rest = rest.slice(end + 2 + size + 2);
  }
};

interface Answer {
  status: number;
  body: string;
  header: (name: string) => string | undefined;
}

/**
 * A request written onto the socket by hand.
 *
 * `fetch` cannot be used for the traversals: the WHATWG URL parser resolves `..` and `%2e%2e`
 * away before a byte leaves the client, so the attack never arrives and the test proves nothing.
 * A phone's browser does the same - but `curl --path-as-is`, any script, and anything that is not
 * a browser do not, and this server is reachable from a tailnet.
 */
const get = async (path: string): Promise<Answer> => {
  const socket = connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  await new Promise<void>((done, fail) => {
    socket.on("connect", () => {
      // `write`, never `end`: a half-close makes Node's HTTP server abandon the response it was
      // in the middle of, and every assertion below would be reading an empty string.
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", fail);
    socket.on("end", () => {
      socket.destroy();
      done();
    });
  });
  const text = Buffer.concat(chunks).toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const head = text.slice(0, split).split("\r\n");
  const headers = new Map(
    head.slice(1).map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
    }),
  );
  const raw = text.slice(split + 4);
  return {
    status: Number((head[0] ?? "").split(" ")[1]),
    body: headers.get("transfer-encoding") === "chunked" ? dechunk(raw) : raw,
    header: (name) => headers.get(name),
  };
};

void describe("the built client", () => {
  void test("the root serves index.html, uncached, with nothing injected", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.equal(res.header("content-type"), "text/html; charset=utf-8");
    assert.equal(res.header("cache-control"), "no-cache");
    assert.equal(res.body, readFileSync(join(root, "index.html"), "utf8"));
  });

  void test("a hashed asset gets its own MIME type and an immutable cache", async () => {
    const res = await get("/assets/index-abc123.js");
    assert.equal(res.status, 200);
    assert.equal(res.header("content-type"), "text/javascript; charset=utf-8");
    assert.match(res.header("cache-control") ?? "", /immutable/);
  });

  void test("an unknown path falls back to index.html so client routes work", async () => {
    const res = await get("/session/abc");
    assert.equal(res.status, 200);
    assert.equal(res.header("content-type"), "text/html; charset=utf-8");
  });

  void test("a missing asset is a 404, not the HTML page", async () => {
    const res = await get("/assets/index-gone.js");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, /doctype/i);
  });
});

void describe("escaping the build directory", () => {
  const escapes = [
    "/../private/token",
    "/assets/../../private/token",
    "/%2e%2e/private/token",
    "/%2e%2e%2f%2e%2e%2fprivate%2ftoken",
    `/${encodeURIComponent(resolve("/etc/passwd"))}`,
    "/leak",
    "/assets/elsewhere/token",
    "/index.html%00.png",
  ];

  for (const path of escapes) {
    void test(`${path} is refused rather than served`, async () => {
      const res = await get(path);
      // The proof the refusal is real: the file it went after is read here, and its contents
      // must not appear in the answer whatever the status line says.
      assert.equal(readFileSync(secretFile, "utf8"), SECRET);
      assert.ok(!res.body.includes(SECRET), `${path} served the file it tried to steal`);
      assert.ok(res.status === 403 || res.status === 404, `${path} answered ${String(res.status)}`);
    });
  }

  void test("a double-encoded climb is a filename, and lands inside the build directory", async () => {
    // `%252f` decodes once to the literal text `%2f`, which is a character a filename may
    // contain and not a separator. Plan 001 asks that such a path land inside the build
    // directory or be refused; this one lands inside it, finds nothing, and gets the page.
    const res = await get("/..%252fprivate/token");
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(SECRET));
    assert.equal(res.header("content-type"), "text/html; charset=utf-8");
  });
});

void describe("API and socket routes", () => {
  void test("a 404 from the API stays a JSON 404", async () => {
    const res = await get("/api/nope");
    assert.equal(res.status, 404);
    assert.equal(res.header("content-type"), "application/json");
    assert.deepEqual(JSON.parse(res.body), { error: "no route" });
  });

  void test("/ws is the socket route's, not the page's", async () => {
    const res = await get("/ws");
    assert.equal(res.status, 404);
    assert.equal(res.header("content-type"), "application/json");
  });
});

void describe("an unbuilt client", () => {
  let unbuilt: Server;
  let unbuiltBase: string;

  void before(async () => {
    unbuilt = createServer(withClient(api as never, join(tmpdir(), "agentdeck-no-such-build")));
    await new Promise<void>((ready) => unbuilt.listen(0, "127.0.0.1", ready));
    unbuiltBase = `http://127.0.0.1:${String((unbuilt.address() as AddressInfo).port)}`;
  });
  void after(() => {
    unbuilt.close();
  });

  void test("serves a sentence naming the command to run, not a silent 404", async () => {
    const res = await fetch(`${unbuiltBase}/`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /pnpm build/);
  });

  void test("the API still answers", async () => {
    const res = await fetch(`${unbuiltBase}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "application/json");
  });
});
