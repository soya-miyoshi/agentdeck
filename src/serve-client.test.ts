// m2/serve-client's done-when, executed against the real thing rather than against a fixture.
//
// `src/static.test.ts` drives `withClient` over a temp directory shaped like a build. This file
// drives the SERVER: a spawned `src/server.ts`, its own `CLIENT_DIR`, the real Vite output in
// `dist/client`, and requests written onto the socket by hand. That difference is the point -
// nothing in the unit test would notice if `server.ts` stopped wiring the static handler in, or
// pointed it at a directory that does not exist, and both of those present as "the phone loads
// nothing" rather than as a failing assertion.
//
// The secret this file tries to steal is the server's own bearer token. It is real: the file at
// `$HOME/.agentdeck/token` starts sessions in every allowed repository, and there is no boundary
// between an agent and the home directory on this machine. Every refusal below is checked by
// reading that file and asserting the bytes never appear in a response, so a test that passes
// because the answer was a 403 for some unrelated reason still fails if the token comes back.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(repoRoot, "src", "server.ts");
const clientDir = join(repoRoot, "dist", "client");
const socket = `agentdeck-serve-${String(process.pid)}`;
// Configured so the Origin check is ON, which is the only way to show that serving the page is
// unauthenticated WITHOUT the API having loosened alongside it.
const EXPECTED_ORIGIN = "https://deck.example.ts.net";

let home = "";
let work = "";
let port = 0;
let token = "";
let child: ChildProcess | undefined;
let plantedLink: string | undefined;

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const freePort = async (): Promise<number> =>
  await new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        done(found);
      });
    });
  });

interface Answer {
  status: number;
  body: string;
  header: (name: string) => string | undefined;
}

/** A file is streamed, so it arrives chunk-framed; the frames are not part of what was served. */
const dechunk = (raw: string): string => {
  let rest = raw;
  let out = "";
  for (;;) {
    const end = rest.indexOf("\r\n");
    if (end < 0) return out;
    const size = parseInt(rest.slice(0, end), 16);
    if (!(size > 0)) return out;
    out += rest.slice(end + 2, end + 2 + size);
    rest = rest.slice(end + 2 + size + 2);
  }
};

/**
 * A request written onto the socket by hand.
 *
 * `fetch` cannot be used for the traversals: the WHATWG URL parser resolves `..` and `%2e%2e`
 * away before a byte leaves the client, so the attack never arrives and the test proves nothing.
 * A phone's browser does the same - but `curl --path-as-is`, any script, and anything that is not
 * a browser do not, and this server is reachable from a tailnet.
 */
const request = async (
  path: string,
  extra: Record<string, string> = {},
  method = "GET",
): Promise<Answer> => {
  const client = connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  await new Promise<void>((done, fail) => {
    client.on("connect", () => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        ...Object.entries(extra).map(([name, value]) => `${name}: ${value}`),
        "Connection: close",
      ];
      // `write`, never `end`: a half-close makes Node's HTTP server abandon the response it was
      // in the middle of, and every assertion below would be reading an empty string.
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    client.on("error", fail);
    client.on("end", () => {
      client.destroy();
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

before(async () => {
  // The build is what is under test, so a stale or absent one is built rather than skipped over:
  // a self-skipping test for the one thing this item delivers is a green tick for nothing.
  try {
    readFileSync(join(clientDir, "index.html"));
  } catch {
    execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit", timeout: 300_000 });
  }

  home = temp("agentdeck-serve-home-");
  work = temp("agentdeck-serve-work-");
  port = await freePort();
  const started = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      TERM: "xterm-256color",
      LC_ALL: "en_US.UTF-8",
      TMUX_SOCKET: socket,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: work,
      AGENTDECK_ORIGIN: EXPECTED_ORIGIN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = started;
  let stdout = "";
  let stderr = "";
  started.stdout.setEncoding("utf8");
  started.stderr.setEncoding("utf8");
  started.stderr.on("data", (chunk: string) => (stderr += chunk));
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => {
      fail(new Error(`the server did not listen within 20s\n${stdout}\n${stderr}`));
    }, 20_000);
    timer.unref();
    started.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("listening on")) {
        clearTimeout(timer);
        ready();
      }
    });
    started.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`the server exited ${String(code)} instead of listening\n${stderr}`));
    });
  });
  token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
  assert.ok(token.length > 0, "the server did not write a token to steal");

  // A symlink planted inside the REAL build output, pointing at the REAL token file. Nothing in
  // the request path that reaches it looks suspicious - no dots, no encoding, one ordinary name -
  // so a handler that inspects the string and never the resolved file serves the token here.
  plantedLink = join(clientDir, `planted-${String(process.pid)}`);
  symlinkSync(join(home, ".agentdeck", "token"), plantedLink);
});

after(() => {
  if (plantedLink !== undefined) {
    try {
      unlinkSync(plantedLink);
    } catch {
      // Already gone: the desired end state.
    }
  }
  if (child !== undefined) child.kill("SIGKILL");
  // The tmux server the spawned server started outlives it: `exit-empty off` keeps a tmux holding
  // no sessions alive until something signals it. Killing the node process alone leaked one a run.
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // No server on that socket is the desired end state.
  }
  for (const dir of [home, work]) rmSync(dir, { recursive: true, force: true });
});

void describe("the server serves the built client", () => {
  void test("the root loads with no token at all", async () => {
    const res = await request("/");
    assert.equal(res.status, 200);
    assert.equal(res.header("content-type"), "text/html; charset=utf-8");
    // The bytes Vite wrote, unchanged. Byte identity IS the "inject nothing" assertion: a token,
    // an origin or a bootstrap config would all have to change this file to arrive.
    assert.equal(res.body, readFileSync(join(clientDir, "index.html"), "utf8"));
    assert.ok(!res.body.includes(token), "the page carried the token it is supposed to ask for");
    assert.doesNotMatch(res.body, /AGENTDECK|__INITIAL|window\./);
  });

  void test("index.html is not cached hard, so a deploy is not permanent", async () => {
    const res = await request("/");
    const cache = res.header("cache-control") ?? "";
    assert.match(cache, /no-cache|no-store|max-age=0/);
    assert.doesNotMatch(cache, /immutable/);
  });

  void test("the module the page names is served as JavaScript, and cached by its hash", async () => {
    const page = (await request("/")).body;
    const script = /<script[^>]+src="([^"]+)"/.exec(page)?.[1];
    assert.ok(script !== undefined, "the built page names no module to load");
    const res = await request(script.startsWith("/") ? script : `/${script}`);
    assert.equal(res.status, 200);
    // A `.js` served as `text/plain` does not execute, and the page is then blank with nothing
    // in the server log to say why.
    assert.match(res.header("content-type") ?? "", /javascript/);
    assert.match(res.header("cache-control") ?? "", /immutable/);
  });

  void test("the first thing the client shows is the paste field", async () => {
    // `fetch` here rather than the hand-written request: this path has nothing to hide from the
    // URL parser, and the bundle is 400kB, which is a body worth letting node reassemble.
    const base = `http://127.0.0.1:${String(port)}`;
    const page = await (await fetch(`${base}/`)).text();
    const script = /<script[^>]+src="([^"]+)"/.exec(page)?.[1] ?? "";
    const bundle = await (await fetch(new URL(script, `${base}/`))).text();
    // TokenGate's own strings, from the built bundle rather than from the source: the gate is
    // what App renders before a token exists, so a build that shipped without it - or a page
    // handed a token by the server and skipping the gate - loses these.
    assert.match(bundle, /Paste the token the server printed on first run/);
    assert.match(bundle, /placeholder/);
    assert.ok(!bundle.includes(token), "the bundle carried the token it is supposed to ask for");
  });

  void test("a client route that is not a file gets the page, not a 404", async () => {
    const res = await request("/session/anything");
    assert.equal(res.status, 200);
    assert.equal(res.header("content-type"), "text/html; charset=utf-8");
  });
});

void describe("escaping the build directory, against the running server", () => {
  const escapes = (): string[] => [
    "/../../../.agentdeck/token",
    "/assets/../../../../.agentdeck/token",
    "/%2e%2e/%2e%2e/%2e%2e/.agentdeck/token",
    "/..%2f..%2f..%2f.agentdeck%2ftoken",
    `/${encodeURIComponent(resolve(home, ".agentdeck", "token"))}`,
    "/..\\..\\..\\.agentdeck\\token",
    "/%2e%2e%5c%2e%2e%5c.agentdeck%5ctoken",
    "/....//....//....//.agentdeck/token",
    `/planted-${String(process.pid)}`,
    "/index.html%00.png",
  ];

  for (const path of escapes()) {
    void test(`${path} is refused rather than served`, async () => {
      const res = await request(path);
      // The proof the refusal is real: the file it went after is read here, and its contents
      // must not appear in the answer whatever the status line says.
      const onDisk = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
      assert.equal(onDisk, token);
      assert.ok(!res.body.includes(token), `${path} served the token it tried to steal`);
      assert.ok(res.status !== 200 || res.body.startsWith("<!doctype"), `${path} served a file`);
    });
  }

  void test("an escape is refused, never quietly answered with the page", async () => {
    const res = await request("/../../../.agentdeck/token");
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /doctype/i);
  });
});

void describe("the API and the socket route are untouched by any of this", () => {
  void test("a missing API route stays a JSON 404 rather than becoming the page", async () => {
    const res = await request("/api/nope", { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 404);
    assert.match(res.header("content-type") ?? "", /application\/json/);
    assert.doesNotMatch(res.body, /doctype/i);
    assert.ok(typeof JSON.parse(res.body) === "object");
  });

  void test("an unauthenticated API call is still refused while the page is not", async () => {
    const page = await request("/");
    assert.equal(page.status, 200);
    const api = await request("/api/sessions");
    assert.equal(api.status, 401);
    assert.match(api.header("content-type") ?? "", /application\/json/);
  });

  void test("the Origin check on /api still holds with the page reachable", async () => {
    const res = await request("/api/sessions", {
      Authorization: `Bearer ${token}`,
      Origin: "https://evil.example",
    });
    assert.equal(res.status, 403);
    assert.match(res.header("content-type") ?? "", /application\/json/);
    // And the configured origin is the one that gets through, so the 403 above is the check
    // firing rather than the endpoint being broken.
    const allowed = await request("/api/sessions", {
      Authorization: `Bearer ${token}`,
      Origin: EXPECTED_ORIGIN,
    });
    assert.equal(allowed.status, 200);
  });

  void test("the page itself does not care about Origin - it cannot, and must not", async () => {
    const res = await request("/", { Origin: "https://evil.example" });
    assert.equal(res.status, 200);
    assert.equal(res.header("content-type"), "text/html; charset=utf-8");
  });

  void test("/ws is the socket route's; a plain GET is not the page", async () => {
    const res = await request("/ws");
    assert.doesNotMatch(res.body, /doctype/i);
  });
});

// ---------------------------------------------------------------------------------------------

// `src/client/public/` is copied verbatim into `dist/client` by Vite's `publicDir`, and that copy
// DEREFERENCES symlinks: `copyDir` is statSync + copyFileSync, both of which follow. So a symlink
// planted in the source directory lands in the publish root as a REAL FILE holding the target's
// bytes, and `dist/client` is served to any device that can reach the port with no bearer token.
//
// Measured on this machine before this test existed: a symlink at
// `src/client/public/icons/planted.png` pointing at a file outside the repo produced a regular
// file in `dist/client/icons/planted.png` containing that file's contents.
//
// Three controls miss it, which is why the check has to live here. `static.ts` resolves and checks
// containment against the real root - by serve time it is a real file inside the root, not a
// symlink. The purpose-built "symlink planted inside the REAL build output" test only catches
// symlinks that survive AS symlinks. And the boot guard checks where the token and profiles files
// are configured to be, never what is inside the publish root.
void describe("nothing in the published source directory may point outside it", () => {
  const publicDir = fileURLToPath(new URL("client/public", import.meta.url));

  void test("no entry under src/client/public is a symlink", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // lstat, not stat: the question is what the ENTRY is, not what it points at.
        if (lstatSync(full).isSymbolicLink()) {
          offenders.push(full);
          continue;
        }
        if (entry.isDirectory()) walk(full);
      }
    };
    if (existsSync(publicDir)) walk(publicDir);
    assert.deepEqual(
      offenders,
      [],
      "a symlink here becomes a real file in dist/client, which is served to the tailnet with no token",
    );
  });
});
