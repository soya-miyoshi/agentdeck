import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { parseProfiles, summarise } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Registry } from "./registry.ts";
import { Tmux } from "./tmux.ts";
import { TurnLog, type Turn } from "./turn-log.ts";

// The two routes of plan 007 end to end: a hook payload in, a turn list out.

const SEP = "";
const TOKEN = "test-token-value";
const CWD = "/workspace/agentdeck";

const fakeTmux = (): Tmux => {
  const sessions = new Map<string, string>();
  return new Tmux({
    socket: "test",
    exec: async (args) => {
      const verb = ["list-sessions", "new-session"].find((name) => args.includes(name));
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

// The secret is unreadable from outside the registry, so saying it matched is the only way to
// reach the route's behaviour after authentication.
class OpenRegistry extends Registry {
  override secretMatches(): boolean {
    return true;
  }
}

let server: Server;
let base: string;
let registry: Registry;
let sessionId: string;

before(async () => {
  const { profiles } = parseProfiles({
    claude: { command: "/bin/sh", waiting: { via: "hook", settings: "claude-hooks.json" } },
  });
  const allowlist = new CwdAllowlist([CWD]);
  registry = new OpenRegistry(fakeTmux(), profiles, allowlist);
  const created = await registry.create(CWD, "claude");
  sessionId = created.session.id;
  server = createServer(
    createHandler({
      registry,
      profiles,
      allowlist,
      token: TOKEN,
      version: "0.0.0-test",
      origin: undefined,
      probe: async () => await Promise.resolve(true),
      turns: new TurnLog(mkdtempSync(join(tmpdir(), "agentdeck-route-"))),
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

const hook = async (payload: unknown): Promise<number> => {
  const response = await fetch(`${base}/api/hooks/${sessionId}`, {
    method: "POST",
    headers: { "x-agentdeck-secret": "anything", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await response.arrayBuffer();
  return response.status;
};

const list = async (
  query = "",
  auth = true,
): Promise<{ status: number; turns: Turn[]; truncated: boolean }> => {
  const response = await fetch(`${base}/api/sessions/${sessionId}/turns${query}`, {
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  const body = (await response.json()) as { turns?: Turn[]; truncated?: boolean };
  return { status: response.status, turns: body.turns ?? [], truncated: body.truncated ?? false };
};

void describe("the turn log routes", () => {
  void test("a turn posted as two hook events comes back as one entry", async () => {
    const promptId = "p-round-trip";
    assert.equal(
      await hook({ hook_event_name: "UserPromptSubmit", prompt_id: promptId, prompt: "why?" }),
      200,
    );
    assert.equal(
      await hook({
        hook_event_name: "Stop",
        prompt_id: promptId,
        last_assistant_message: "# Because\n\nof the reason.",
      }),
      200,
    );
    const { status, turns } = await list();
    assert.equal(status, 200);
    const turn = turns.find((candidate) => candidate.promptId === promptId);
    assert.equal(turn?.prompt, "why?");
    assert.equal(turn?.answer, "# Because\n\nof the reason.");
  });

  void test("the same Stop firing twice does not produce two entries", async () => {
    const promptId = "p-refire";
    await hook({ hook_event_name: "Stop", prompt_id: promptId, last_assistant_message: "once" });
    await hook({ hook_event_name: "Stop", prompt_id: promptId, last_assistant_message: "once" });
    const { turns } = await list();
    assert.equal(turns.filter((turn) => turn.promptId === promptId).length, 1);
  });

  void test("a hook still decides state when it carries no turn text", async () => {
    // The turn log is additive. A payload with no prompt_id is the older shape and must keep
    // working exactly as it did.
    const response = await fetch(`${base}/api/hooks/${sessionId}`, {
      method: "POST",
      headers: { "x-agentdeck-secret": "anything", "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    assert.deepEqual(await response.json(), { ok: true, state: "waiting" });
  });

  void test("the list needs the user's token", async () => {
    // The hook route authenticates with the session secret; this one holds what the agent said,
    // and reading it is the phone's business.
    const { status } = await list("", false);
    assert.equal(status, 401);
  });

  void test("limit is honoured and bounded", async () => {
    const { turns, truncated } = await list("?limit=1");
    assert.equal(turns.length, 1);
    assert.equal(truncated, true);
    // A nonsense limit falls back to the server's bound rather than being taken literally.
    assert.equal((await list("?limit=-5")).status, 200);
    assert.equal((await list("?limit=notanumber")).status, 200);
  });

  void test("a session with no history answers an empty list, not a 404", async () => {
    const response = await fetch(`${base}/api/sessions/never-ran/turns`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { turns: [], truncated: false });
  });

  void test("only a hook profile claims to log turns", () => {
    const { profiles } = parseProfiles({
      claude: { command: "/bin/sh", waiting: { via: "hook", settings: "x.json" } },
      shell: { command: "/bin/sh" },
      other: { command: "/bin/sh", waiting: { via: "screen", match: "> $" } },
    });
    const logs = (id: string): boolean => summarise(profiles.get(id)!).logsTurns;
    assert.equal(logs("claude"), true);
    assert.equal(logs("shell"), false);
    // A screen profile knows when the turn ended and not what it said.
    assert.equal(logs("other"), false);
  });
});

void describe("a deployment with no turn store", () => {
  // `turns` is optional on the handler. Without it the hook route must still work and the list
  // must still answer, because a server that has not been given a store is configured, not broken.
  let bare: Server;
  let bareBase: string;

  before(async () => {
    const { profiles } = parseProfiles({ claude: { command: "/bin/sh" } });
    const allowlist = new CwdAllowlist([CWD]);
    const bareRegistry = new OpenRegistry(fakeTmux(), profiles, allowlist);
    await bareRegistry.create(CWD, "claude");
    bare = createServer(
      createHandler({
        registry: bareRegistry,
        profiles,
        allowlist,
        token: TOKEN,
        version: "0.0.0-test",
        origin: undefined,
        probe: async () => await Promise.resolve(true),
      }),
    );
    await new Promise<void>((done) => bare.listen(0, "127.0.0.1", done));
    bareBase = `http://127.0.0.1:${String((bare.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((done) =>
      bare.close(() => {
        done();
      }),
    );
  });

  void test("answers an empty list rather than failing", async () => {
    const response = await fetch(`${bareBase}/api/sessions/anything/turns`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { turns: [], truncated: false });
  });
});
