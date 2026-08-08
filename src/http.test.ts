import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Registry } from "./registry.ts";
import { SessionStream } from "./stream.ts";
import { Tmux } from "./tmux.ts";

const SEP = "\u001f";
const TOKEN = "test-token-value";

const fakeTmux = () => {
  const sessions = new Map<string, { dead: boolean; status: string; path: string }>();
  return new Tmux({
    socket: "test",
    exec: async (args) => {
      // The interesting command is not always first: a create is preceded by the
      // `set-option -g update-environment <names>` that keeps the values out of argv.
      const verb = ["list-sessions", "new-session", "kill-session"].find((n) => args.includes(n));
      const rest = verb === undefined ? args : args.slice(args.indexOf(verb) + 1);
      if (verb === "list-sessions") {
        if (sessions.size === 0) throw Object.assign(new Error("x"), { stderr: "no sessions" });
        const out = [...sessions.entries()]
          .map(([id, s]) => [id, s.dead ? "1" : "0", s.status, "1700000000", s.path].join(SEP))
          .join("\n");
        return await Promise.resolve({ stdout: `${out}\n`, stderr: "" });
      }
      if (verb === "new-session")
        sessions.set(rest[rest.indexOf("-s") + 1] ?? "", {
          dead: false,
          status: "",
          path: rest[rest.indexOf("-c") + 1] ?? "",
        });
      if (verb === "kill-session")
        sessions.delete((rest[rest.indexOf("-t") + 1] ?? "").replace(/^=/, ""));
      return await Promise.resolve({ stdout: "", stderr: "" });
    },
  });
};

let server: Server;
let base: string;
let healthy = true;
let registry: Registry;

before(async () => {
  const { profiles } = parseProfiles({ claude: { command: "/bin/sh", name: "Claude Code" } });
  const allowlist = new CwdAllowlist(["/workspace/agentdeck"]);
  registry = new Registry(fakeTmux(), profiles, allowlist);
  server = createServer(
    createHandler({
      registry,
      profiles,
      allowlist,
      token: TOKEN,
      version: "0.0.0-test",
      origin: "https://mac.example.ts.net",
      probe: async () => await Promise.resolve(healthy),
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
});

const call = async (
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const { auth = true, headers, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

void describe("a request target the URL parser refuses", () => {
  // `fetch` normalises `//` away before a byte leaves the client, so the request has to be written
  // onto the socket by hand. The parse of `req.url` is synchronous and outside every catch in the
  // handler: unguarded, `//` throws `ERR_INVALID_URL` and, with nothing supervising the process,
  // ends the deck. The proof is that an answer comes back and the next request still works.
  const raw = async (target: string): Promise<string> => {
    const socket = connect(Number(new URL(base).port), "127.0.0.1");
    const chunks: Buffer[] = [];
    await new Promise<void>((done, fail) => {
      socket.on("connect", () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", fail);
      socket.on("end", () => {
        socket.destroy();
        done();
      });
    });
    return Buffer.concat(chunks).toString("utf8");
  };

  for (const target of ["//", "/\\", "http://["]) {
    void test(`${target} is a 400, not the process`, async () => {
      const text = await raw(target);
      assert.match(text.split("\r\n")[0] ?? "", /^HTTP\/1\.1 400 /);
      const { status } = await call("/api/health", { auth: false });
      assert.equal(status, 200, `the server did not survive ${target}`);
    });
  }
});

void describe("health", () => {
  void test("is unauthenticated, because the probe must not need the token that starts processes", async () => {
    const { status, body } = await call("/api/health", { auth: false });
    assert.equal(status, 200);
    assert.equal(body["ok"], true);
    assert.equal(body["version"], "0.0.0-test");
  });

  void test("reports 503 when the event loop cannot answer", async () => {
    healthy = false;
    const { status, body } = await call("/api/health", { auth: false });
    assert.equal(status, 503);
    assert.equal(body["ok"], false);
    healthy = true;
  });
});

void describe("authentication", () => {
  void test("every real route refuses without a token", async () => {
    for (const path of ["/api/sessions", "/api/agents", "/api/cwds"]) {
      const { status } = await call(path, { auth: false });
      assert.equal(status, 401, `${path} answered without a token`);
    }
  });

  void test("a wrong token is refused", async () => {
    const { status } = await call("/api/sessions", {
      auth: false,
      headers: { authorization: "Bearer not-the-token" },
    });
    assert.equal(status, 401);
  });

  void test("a token in the query string does not work", async () => {
    // A URL lands in proxy logs, browser history and referrer headers, and this token starts
    // processes.
    const { status } = await call(`/api/sessions?token=${TOKEN}`, { auth: false });
    assert.equal(status, 401);
  });

  void test("a foreign Origin is refused, so a page the phone visits cannot drive the API", async () => {
    const { status } = await call("/api/sessions", { headers: { origin: "https://evil.example" } });
    assert.equal(status, 403);
  });

  void test("POST /api/probe answers ok, needs the token, and is refused for a foreign Origin", async () => {
    // The route the client's admission check calls. It is a POST so that a browser attaches
    // `Origin` to it - a same-origin GET carries none, which made the 403 below unreachable from
    // the only client that ships.
    const unauth = await call("/api/probe", { method: "POST", auth: false });
    assert.equal(unauth.status, 401);

    const foreign = await call("/api/probe", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);

    const before = ((await call("/api/sessions")).body["sessions"] as unknown[]).length;
    const ok = await call("/api/probe", {
      method: "POST",
      headers: { origin: "https://mac.example.ts.net" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body["ok"], true);
    // Side-effect-free: it is a question about this client's admission, not a command.
    assert.equal(((await call("/api/sessions")).body["sessions"] as unknown[]).length, before);
  });

  void test("the expected Origin is allowed", async () => {
    const { status } = await call("/api/sessions", {
      headers: { origin: "https://mac.example.ts.net" },
    });
    assert.equal(status, 200);
  });
});

void describe("sessions", () => {
  void test("creating takes a profile id and never a command line", async () => {
    const { status, body } = await call("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace/agentdeck", agent: "claude" }),
    });
    assert.equal(status, 201);
    const session = body["session"] as Record<string, unknown>;
    assert.equal(session["agent"], "claude");
    assert.equal(session["cwd"], "/workspace/agentdeck");
  });

  void test("a command in the body is ignored rather than honoured", async () => {
    const { status, body } = await call("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace/agentdeck", agent: "claude", command: "/bin/evil" }),
    });
    assert.equal(status, 201);
    assert.doesNotMatch(JSON.stringify(body), /evil/);
  });

  void test("a cwd off the mount list is 403 with a sentence, not a bare code", async () => {
    const { status, body } = await call("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/etc", agent: "claude" }),
    });
    assert.equal(status, 403);
    assert.match(String(body["error"]), /AGENTDECK_MOUNTS/);
  });

  void test("an unknown agent is 404", async () => {
    const { status } = await call("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace/agentdeck", agent: "nope" }),
    });
    assert.equal(status, 404);
  });

  void test("a missing field is 400", async () => {
    const { status } = await call("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace/agentdeck" }),
    });
    assert.equal(status, 400);
  });

  void test("listing never carries a secret", async () => {
    const { body } = await call("/api/sessions");
    assert.doesNotMatch(JSON.stringify(body), /secret/i);
  });
});

void describe("agents and cwds", () => {
  void test("agents report availability and whether they detect waiting", async () => {
    const { body } = await call("/api/agents");
    const [agent] = body["agents"] as { id: string; available: boolean; detectsWaiting: boolean }[];
    assert.equal(agent?.id, "claude");
    assert.equal(agent?.available, true, "/bin/sh resolves");
    assert.equal(agent?.detectsWaiting, false, "no mechanism configured");
  });

  void test("cwds serves the mount list with the live sessions in each", async () => {
    const { body } = await call("/api/cwds");
    const [cwd] = body["cwds"] as { path: string; name: string; sessions: string[] }[];
    assert.equal(cwd?.path, "/workspace/agentdeck");
    assert.equal(cwd?.name, "agentdeck");
    assert.ok((cwd?.sessions.length ?? 0) >= 1, "the session created above should appear here");
  });
});

void describe("the hook route", () => {
  void test("does NOT accept the user's bearer token", async () => {
    // The asymmetry is the whole point: that token is the phone's, and writing it into a
    // settings file a coding agent reads by design hands the agent every session on the machine.
    const [session] = await registry.list();
    assert.ok(session);
    const { status } = await call(`/api/hooks/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    assert.equal(status, 401);
  });

  void test("refuses an unknown session", async () => {
    const { status } = await call("/api/hooks/no-such-session", {
      auth: false,
      method: "POST",
      headers: { "x-agentdeck-secret": "anything", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(status, 401);
  });
});

// The secret is deliberately unreadable from outside the registry, so the only way to exercise
// the route's behaviour AFTER authentication is to say the secret matched.
class OpenRegistry extends Registry {
  override secretMatches(): boolean {
    return true;
  }
}

void describe("a hook that authenticates routes its event into the session's state", () => {
  let hookServer: Server;
  let hookBase: string;
  let hookRegistry: Registry;
  let stream: SessionStream;
  // Every state this route announced onward, in order. A hook exists to arrive AT the transition
  // (plan 002), so a route that only wrote the state down and left the strip to ask for it later
  // is the poll this item refuses - and that failure is invisible in the response body, which is
  // identical either way.
  const declared: { id: string; state: string }[] = [];

  before(async () => {
    const { profiles } = parseProfiles({ claude: { command: "/bin/sh" } });
    hookRegistry = new OpenRegistry(
      fakeTmux(),
      profiles,
      new CwdAllowlist(["/workspace/agentdeck"]),
    );
    await hookRegistry.create("/workspace/agentdeck", "claude");
    stream = new SessionStream({ sessionId: "test" });
    hookServer = createServer(
      createHandler({
        registry: hookRegistry,
        profiles,
        allowlist: new CwdAllowlist(["/workspace/agentdeck"]),
        token: TOKEN,
        version: "0.0.0-test",
        origin: undefined,
        probe: async () => await Promise.resolve(true),
        streamFor: () => stream,
        onStateDeclared: (id, state) => declared.push({ id, state }),
      }),
    );
    await new Promise<void>((done) => hookServer.listen(0, "127.0.0.1", done));
    hookBase = `http://127.0.0.1:${String((hookServer.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((done) =>
      hookServer.close(() => {
        done();
      }),
    );
  });

  const post = async (payload: unknown): Promise<Record<string, unknown>> => {
    const [session] = await hookRegistry.list();
    assert.ok(session);
    const response = await fetch(`${hookBase}/api/hooks/${session.id}`, {
      method: "POST",
      headers: { "x-agentdeck-secret": "anything", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json()) as Record<string, unknown>;
  };

  void test("Stop declares waiting on the stream and on the list", async () => {
    assert.deepEqual(await post({ hook_event_name: "Stop" }), { ok: true, state: "waiting" });
    assert.equal(stream.state(), "waiting");
    const [session] = await hookRegistry.list();
    assert.equal(session?.state, "waiting");
  });

  void test("PreToolUse declares working", async () => {
    assert.deepEqual(await post({ hook_event_name: "PreToolUse", tool_name: "Bash" }), {
      ok: true,
      state: "working",
    });
    assert.equal(stream.state(), "working");
  });

  void test("an unrecognised event name leaves the state alone", async () => {
    await post({ hook_event_name: "Stop" });
    assert.deepEqual(await post({ hook_event_name: "PreCompact" }), { ok: true, state: null });
    assert.equal(stream.state(), "waiting", "the previous statement must still stand");
  });

  void test("the state it declared is pushed onward, naming the session it belongs to", async () => {
    const [session] = await hookRegistry.list();
    assert.ok(session);
    const before = declared.length;
    await post({ hook_event_name: "Stop" });
    assert.deepEqual(
      declared.slice(before),
      [{ id: session.id, state: "waiting" }],
      "the hook wrote the state down and told nobody: the strip can only learn this by asking",
    );
  });

  void test("an event that changes no state announces nothing", async () => {
    // Repeats and non-events are not news. A frame per hook POST would make the strip's traffic a
    // function of how chatty the agent is rather than of how often it changed what a person sees.
    await post({ hook_event_name: "Stop" });
    const before = declared.length;
    assert.deepEqual(await post({ hook_event_name: "PreCompact" }), { ok: true, state: null });
    assert.deepEqual(declared.slice(before), []);
  });

  void test("a body that is not JSON is 400 rather than 500", async () => {
    const [session] = await hookRegistry.list();
    assert.ok(session);
    const response = await fetch(`${hookBase}/api/hooks/${session.id}`, {
      method: "POST",
      headers: { "x-agentdeck-secret": "anything", "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(response.status, 400);
  });
});

// The push is a broadcast to every open socket, so a POST that can move a tab without proving it
// is the session it claims to be is a way to make somebody's phone say the wrong session needs
// them. The real Registry is used here rather than the open one above, because the secret check is
// the thing under test.
void describe("a hook that does not authenticate moves nothing and tells nobody", () => {
  void test("a wrong secret is 401 and announces no state", async () => {
    const { profiles } = parseProfiles({ claude: { command: "/bin/sh" } });
    const allowlist = new CwdAllowlist(["/workspace/agentdeck"]);
    const closedRegistry = new Registry(fakeTmux(), profiles, allowlist);
    const { session } = await closedRegistry.create("/workspace/agentdeck", "claude");
    const declared: string[] = [];
    const closedServer = createServer(
      createHandler({
        registry: closedRegistry,
        profiles,
        allowlist,
        token: TOKEN,
        version: "0.0.0-test",
        origin: undefined,
        probe: async () => await Promise.resolve(true),
        onStateDeclared: (_id, state) => declared.push(state),
      }),
    );
    await new Promise<void>((done) => closedServer.listen(0, "127.0.0.1", done));
    const closedBase = `http://127.0.0.1:${String((closedServer.address() as AddressInfo).port)}`;

    const response = await fetch(`${closedBase}/api/hooks/${session.id}`, {
      method: "POST",
      headers: { "x-agentdeck-secret": "not-the-secret", "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(declared, []);
    assert.equal((await closedRegistry.list())[0]?.state, "idle", "the state moved anyway");

    await new Promise<void>((done) =>
      closedServer.close(() => {
        done();
      }),
    );
  });
});

void describe("an unexpected failure says nothing about itself", () => {
  void test("the 500 body carries a reference, not the error text", async () => {
    // Errors are sentences the client renders verbatim, and the ones that reach here are not
    // sentences anybody wrote: `execFile` alone puts its whole argv - the per-session secret and
    // every profile-passed API key among it - into one. A fixed sentence plus an id, with the
    // real text on the server log.
    class ExplodingRegistry extends Registry {
      override async list(): Promise<never> {
        return await Promise.reject(
          new Error("Command failed: tmux -e AGENTDECK_SECRET=s3cret -e API_KEY=sk-live-xyz"),
        );
      }
    }
    const { profiles } = parseProfiles({ claude: { command: "/bin/sh" } });
    const allowlist = new CwdAllowlist(["/workspace/agentdeck"]);
    const failing = createServer(
      createHandler({
        registry: new ExplodingRegistry(fakeTmux(), profiles, allowlist),
        profiles,
        allowlist,
        token: TOKEN,
        version: "0.0.0-test",
        origin: undefined,
        probe: async () => await Promise.resolve(true),
      }),
    );
    await new Promise<void>((done) => failing.listen(0, "127.0.0.1", done));
    try {
      const port = (failing.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 500);
      const text = String(((await response.json()) as Record<string, unknown>)["error"]);
      assert.doesNotMatch(text, /s3cret/);
      assert.doesNotMatch(text, /sk-live-xyz/);
      assert.match(text, /ref [0-9a-f]{12}/);
    } finally {
      await new Promise<void>((done) => failing.close(() => done()));
    }
  });
});

void describe("responses", () => {
  void test("an unknown route is 404 and says what it did not match", async () => {
    const { status, body } = await call("/api/nonexistent");
    assert.equal(status, 404);
    assert.match(String(body["error"]), /\/api\/nonexistent/);
  });

  void test("an oversized body is refused rather than buffered", async () => {
    const response = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "x".repeat(200_000),
    });
    // 413 and the sentence someone wrote, not the generic 500: that one now says nothing about
    // what failed, because arbitrary error text reaches the client verbatim.
    assert.equal(response.status, 413);
    assert.match(
      String(((await response.json()) as Record<string, unknown>)["error"]),
      /too large/,
    );
  });

  void test("responses are not cacheable and not sniffable", async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});
