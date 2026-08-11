import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, utimes } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Registry } from "./registry.ts";
import { Tmux } from "./tmux.ts";
import { extensionFor, UnsupportedImageError, UploadStore } from "./uploads.ts";

const SEP = "\u001f";
const TOKEN = "test-token-value";
const CWD = "/workspace/agentdeck";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

const fakeTmux = () => {
  const sessions = new Map<string, string>();
  return new Tmux({
    socket: "test",
    exec: async (args) => {
      const verb = ["list-sessions", "new-session", "kill-session"].find((n) => args.includes(n));
      const rest = verb === undefined ? args : args.slice(args.indexOf(verb) + 1);
      if (verb === "list-sessions") {
        if (sessions.size === 0) throw Object.assign(new Error("x"), { stderr: "no sessions" });
        const out = [...sessions.entries()]
          .map(([id, path]) => [id, "0", "", "1700000000", path].join(SEP))
          .join("\n");
        return await Promise.resolve({ stdout: `${out}\n`, stderr: "" });
      }
      if (verb === "new-session")
        sessions.set(rest[rest.indexOf("-s") + 1] ?? "", rest[rest.indexOf("-c") + 1] ?? "");
      return await Promise.resolve({ stdout: "", stderr: "" });
    },
  });
};

void describe("what may be written", () => {
  void test("the extension comes from the declared type, with parameters ignored", () => {
    assert.equal(extensionFor("image/png"), "png");
    assert.equal(extensionFor("image/jpeg; charset=binary"), "jpg");
    assert.equal(extensionFor("IMAGE/PNG"), "png");
  });

  // The safelist is the whole defence: nothing the client sends becomes part of a filename, so
  // there is no traversal to sanitise - only a type that is or is not on the list.
  void test("anything not an image on the list is refused", () => {
    for (const type of ["text/html", "application/x-sh", "image/svg+xml", undefined, ""]) {
      assert.equal(extensionFor(type), undefined, `${String(type)} was accepted`);
    }
  });
});

void describe("UploadStore", () => {
  void test("names the file itself and never the client", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentdeck-uploads-"));
    const store = new UploadStore(root);
    const path = await store.save("repo-claude-abcd1234", "image/png", PNG);
    assert.match(path, /\/repo-claude-abcd1234\/[0-9a-f]{12}\.png$/);
    assert.deepEqual(await readFile(path), PNG);
  });

  void test("a session id that is not one is still confined to one directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentdeck-uploads-"));
    const store = new UploadStore(root);
    const path = await store.save("../../etc/cron.d", "image/png", PNG);
    assert.ok(path.startsWith(`${root}/`), `${path} escaped ${root}`);
    assert.ok(!path.includes(".."), path);
  });

  void test("refuses a type off the safelist without writing anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentdeck-uploads-"));
    const store = new UploadStore(root);
    await assert.rejects(
      async () => await store.save("s", "text/html", PNG),
      (error: unknown) => error instanceof UnsupportedImageError,
    );
    assert.deepEqual(await readdir(root), []);
  });

  // A button on a phone must not grow disk without end.
  void test("keeps only the newest few", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentdeck-uploads-"));
    const store = new UploadStore(root, 2);
    const written: string[] = [];
    for (let i = 0; i < 4; i++) {
      const path = await store.save("s", "image/png", PNG);
      // Stamped apart by hand: four writes inside one millisecond order arbitrarily by mtime, and
      // the test would then be about the filesystem's clock rather than about the pruning.
      await utimes(path, new Date(1700000000000 + i * 1000), new Date(1700000000000 + i * 1000));
      written.push(path);
    }
    const left = (await readdir(join(root, "s"))).sort();
    assert.equal(left.length, 2);
    assert.deepEqual(
      left,
      written
        .slice(2)
        .map((p) => p.split("/").pop())
        .sort(),
    );
  });
});

void describe("POST /api/sessions/:id/uploads", () => {
  let server: Server;
  let base: string;
  let sessionId: string;
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "agentdeck-uploads-"));
    const { profiles } = parseProfiles({ claude: { command: "/bin/sh", name: "Claude Code" } });
    const allowlist = new CwdAllowlist([CWD]);
    const registry = new Registry(fakeTmux(), profiles, allowlist, "test-secret-key");
    server = createServer(
      createHandler({
        registry,
        profiles,
        allowlist,
        token: TOKEN,
        version: "0.0.0-test",
        origin: undefined,
        probe: async () => await Promise.resolve(true),
        uploads: new UploadStore(root),
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    sessionId = (await registry.create(CWD, "claude")).session.id;
  });

  after(async () => {
    // `close` waits for every idle keep-alive socket fetch left behind, and the runner gives up
    // first - the suite then fails with a pending promise while every test in it passed.
    server.closeAllConnections();
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
  });

  const post = async (
    id: string,
    body: Uint8Array | string,
    type = "image/png",
    auth = true,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/uploads`, {
      method: "POST",
      headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), "content-type": type },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  void test("writes the bytes and answers with the path", async () => {
    const { status, body } = await post(sessionId, PNG);
    assert.equal(status, 201);
    assert.deepEqual(await readFile(String(body["path"])), PNG);
  });

  void test("needs the user's token", async () => {
    const { status } = await post(sessionId, PNG, "image/png", false);
    assert.equal(status, 401);
  });

  // The id arrives as a raw path segment. An id the registry will not list must not get a
  // directory: this is the only thing between a URL and mkdir.
  void test("refuses a session that is not ours", async () => {
    const { status } = await post("../../../etc", PNG);
    assert.equal(status, 404);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name !== sessionId),
      [],
    );
  });

  void test("refuses a type off the safelist", async () => {
    const { status } = await post(sessionId, "<script>", "text/html");
    assert.equal(status, 415);
  });

  void test("refuses an empty body rather than writing a zero-byte image", async () => {
    const { status } = await post(sessionId, new Uint8Array());
    assert.equal(status, 400);
  });

  void test("refuses a body above the ceiling", async () => {
    const { status } = await post(sessionId, new Uint8Array(9 * 1024 * 1024));
    assert.equal(status, 413);
  });
});
