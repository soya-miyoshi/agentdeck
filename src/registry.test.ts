import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { CwdNotAllowedError, Registry, UnknownAgentError } from "./registry.ts";
import { Tmux } from "./tmux.ts";

const SEP = "\u001f";

/**
 * A tmux stand-in that actually models sessions, so create/list/kill can be exercised as a whole
 * rather than one call at a time.
 */
const fakeTmux = () => {
  const sessions = new Map<
    string,
    { dead: boolean; status: string; created: number; path: string }
  >();
  const tmux = new Tmux({
    socket: "test",
    exec: async (args) => {
      const [verb, ...rest] = args;
      if (verb === "list-sessions") {
        if (sessions.size === 0) throw Object.assign(new Error("x"), { stderr: "no sessions" });
        const out = [...sessions.entries()]
          .map(([id, s]) => [id, s.dead ? "1" : "0", s.status, String(s.created), s.path].join(SEP))
          .join("\n");
        return await Promise.resolve({ stdout: `${out}\n`, stderr: "" });
      }
      if (verb === "new-session") {
        const id = rest[rest.indexOf("-s") + 1] ?? "";
        const path = rest[rest.indexOf("-c") + 1] ?? "";
        sessions.set(id, { dead: false, status: "", created: 1_700_000_000, path });
      }
      if (verb === "kill-session") {
        // The real tmux resolves `=name` as an exact match and anything else by prefix or
        // fnmatch; the fake only needs to accept the exact form the code is required to send.
        const target = rest[rest.indexOf("-t") + 1] ?? "";
        assert.ok(target.startsWith("="), `kill target must be exact, got ${target}`);
        sessions.delete(target.slice(1));
      }
      return await Promise.resolve({ stdout: "", stderr: "" });
    },
  });
  const die = (id: string, status: string) => {
    const existing = sessions.get(id);
    if (existing) sessions.set(id, { ...existing, dead: true, status });
  };
  const plant = (id: string, path: string) => {
    sessions.set(id, { dead: false, status: "", created: 1_700_000_000, path });
  };
  return { tmux, sessions, die, plant };
};

const build = () => {
  const { tmux, sessions, die, plant } = fakeTmux();
  const { profiles } = parseProfiles({
    claude: { command: "/bin/sh", name: "Claude Code" },
    gemini: { command: "/bin/sh", name: "Gemini CLI" },
  });
  const allowlist = new CwdAllowlist(["/workspace/agentdeck", "/workspace/web"]);
  return { registry: new Registry(tmux, profiles, allowlist), sessions, die, plant };
};

void describe("creating sessions", () => {
  void test("refuses a cwd off the mount list, with a sentence that says what to change", async () => {
    const { registry } = build();
    await assert.rejects(
      async () => await registry.create("/workspace/not-mounted", "claude"),
      (error: Error) => {
        assert.ok(error instanceof CwdNotAllowedError);
        assert.match(error.message, /AGENTDECK_MOUNTS/);
        return true;
      },
    );
  });

  void test("refuses an unknown agent", async () => {
    const { registry } = build();
    await assert.rejects(
      async () => await registry.create("/workspace/agentdeck", "nonexistent"),
      UnknownAgentError,
    );
  });

  void test("a first session has no warning", async () => {
    const { registry } = build();
    const result = await registry.create("/workspace/agentdeck", "claude");
    assert.equal(result.warning, undefined);
    assert.equal(result.session.cwd, "/workspace/agentdeck");
    assert.equal(result.session.agent, "claude");
    assert.equal(result.session.name, "agentdeck");
    assert.equal(result.session.state, "idle");
  });

  void test("two DIFFERENT agents in one tree produce two sessions and a warning", async () => {
    // Allowed but worth saying out loud: a read-only reviewer alongside a writer is legitimate,
    // and the tool cannot tell which case it is looking at. Refusing would be guessing.
    const { registry } = build();
    await registry.create("/workspace/agentdeck", "claude");
    const second = await registry.create("/workspace/agentdeck", "gemini");

    assert.match(second.warning ?? "", /claude/);
    assert.match(second.warning ?? "", /already running/);
    assert.equal((await registry.list()).length, 2);
  });

  void test("the SAME agent twice hands back the running one and says so", async () => {
    // The deliberate collision. A second identical agent in one tree is more often a forgotten
    // tab than an intention, and handing back the running one is the better failure.
    const { registry } = build();
    const first = await registry.create("/workspace/agentdeck", "claude");
    const second = await registry.create("/workspace/agentdeck", "claude");

    assert.equal(second.session.id, first.session.id);
    assert.match(second.warning ?? "", /already running/);
    assert.equal((await registry.list()).length, 1);
  });

  void test("the same repo under two agents gets two distinct ids", async () => {
    const { registry } = build();
    const a = await registry.create("/workspace/agentdeck", "claude");
    const b = await registry.create("/workspace/agentdeck", "gemini");
    assert.notEqual(a.session.id, b.session.id);
  });
});

void describe("listing and exit", () => {
  void test("an empty tmux is an empty list", async () => {
    const { registry } = build();
    assert.deepEqual(await registry.list(), []);
  });

  void test("a session whose command exited still lists, as exited, with its code", async () => {
    const { registry, die } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    die(session.id, "137");

    const [listed] = await registry.list();
    assert.equal(listed?.state, "exited");
    assert.equal(listed?.exitCode, 137);
  });

  void test("a live session reports no exit code", async () => {
    const { registry } = build();
    await registry.create("/workspace/agentdeck", "claude");
    const [listed] = await registry.list();
    assert.equal(listed?.exitCode, undefined);
    assert.notEqual(listed?.state, "exited");
  });

  void test("reaping removes dead sessions and leaves live ones", async () => {
    const { registry, die } = build();
    const dead = await registry.create("/workspace/agentdeck", "claude");
    const live = await registry.create("/workspace/web", "claude");
    die(dead.session.id, "1");

    const reaped = await registry.reap();
    assert.deepEqual(reaped, [dead.session.id]);
    const remaining = await registry.list();
    assert.deepEqual(
      remaining.map((s) => s.id),
      [live.session.id],
    );
  });

  void test("sessions group by cwd for the picker", async () => {
    const { registry } = build();
    await registry.create("/workspace/agentdeck", "claude");
    await registry.create("/workspace/agentdeck", "gemini");
    await registry.create("/workspace/web", "claude");

    const byCwd = await registry.sessionsByCwd();
    assert.equal(byCwd.get("/workspace/agentdeck")?.length, 2);
    assert.equal(byCwd.get("/workspace/web")?.length, 1);
  });
});

void describe("the per-session secret", () => {
  void test("matches only its own session", async () => {
    const { registry } = build();
    const a = await registry.create("/workspace/agentdeck", "claude");
    const b = await registry.create("/workspace/web", "claude");

    assert.equal(registry.secretMatches(a.session.id, "wrong"), false);
    assert.equal(registry.secretMatches("no-such-session", "anything"), false);
    assert.notEqual(a.session.id, b.session.id);
  });

  void test("never appears in a listed session", async () => {
    // The asymmetry plan 002 rests on: a leaked session secret can lie about one session's
    // status, while the user's token can start processes. Neither belongs in a response body.
    const { registry } = build();
    await registry.create("/workspace/agentdeck", "claude");
    const serialised = JSON.stringify(await registry.list());
    assert.doesNotMatch(serialised, /secret/i);
  });

  void test("survives a reattach, so a running agent's hook keeps working", async () => {
    const { registry } = build();
    const first = await registry.create("/workspace/agentdeck", "claude");
    await registry.create("/workspace/agentdeck", "claude");
    // Same session, so whatever secret was handed to the running process must still be accepted.
    assert.equal(first.session.id, (await registry.list())[0]?.id);
  });
});

void describe("closing", () => {
  void test("removes the session and forgets its secret", async () => {
    const { registry } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    await registry.close(session.id);
    assert.deepEqual(await registry.list(), []);
    assert.equal(registry.secretMatches(session.id, "anything"), false);
  });

  void test("closing something already gone is not an error", async () => {
    const { registry } = build();
    await assert.doesNotReject(async () => await registry.close("never-existed"));
  });

  void test("will not kill a session it would not list", async () => {
    // The boundary was one-way: a session started by hand under the same socket is not listed,
    // not attached and not reaped - and was still killable by DELETE /api/sessions/:id, along
    // with everything running in it.
    const { registry, sessions, plant } = build();
    plant("notes", "/home/someone");
    await registry.close("notes");
    assert.ok(sessions.has("notes"));
  });

  void test("a prefix of a real id kills nothing", async () => {
    // tmux -t resolves by prefix and then as an fnmatch pattern, so a stale or mistyped id from
    // the phone must miss rather than hit whatever happens to share a prefix.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    await registry.close(session.id.slice(0, 4));
    await registry.close("*");
    assert.ok(sessions.has(session.id));
  });
});

void describe("the allowlist is matched against where tmux says a session is", () => {
  void test("a session renamed onto ours, pointed elsewhere, is not listed", async () => {
    // The session name is sessionId(cwd, agent) - a pure function of two knowable things - so
    // anything running as this user can kill ours and recreate it under the same name with -c /.
    // Enforcing against the remembered cwd made that shell a tab, reported as being in the repo.
    const { registry, sessions, plant } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    sessions.delete(session.id);
    plant(session.id, "/");
    assert.deepEqual(await registry.list(), []);
  });

  void test("the reported cwd is the one tmux reports", async () => {
    const { registry } = build();
    await registry.create("/workspace/web", "claude");
    assert.equal((await registry.list())[0]?.cwd, "/workspace/web");
  });
});
