import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { CwdNotAllowedError, Registry, UnknownAgentError } from "./registry.ts";
import { sessionId } from "./session-id.ts";
import { Tmux } from "./tmux.ts";

const SEP = "\u001f";

/**
 * A tmux stand-in that actually models sessions, so create/list/kill can be exercised as a whole
 * rather than one call at a time.
 */
type FakeSessions = Map<string, { dead: boolean; status: string; created: number; path: string }>;

// `list-throws` and `list-omits` are the two ways the call after a create can fail (m0/create-500):
// tmux not answering at all, and tmux answering without the session that was just made.
type FakeMode = "ok" | "list-throws" | "list-omits";

const NO_SESSIONS: FakeSessions = new Map();

// The map is a parameter so a second Tmux can be built over the SAME socket state, which is what
// a server restart is: the sessions outlive the process that remembered anything about them.
const fakeTmux = (sessions: FakeSessions = new Map()) => {
  let mode: FakeMode = "ok";
  const tmux = new Tmux({
    socket: "test",
    exec: async (args) => {
      // One invocation chains several tmux commands and the interesting one is not always first -
      // a create is preceded by the `set-option -g update-environment <names>` that carries the
      // session's secrets in the client environment rather than in argv.
      const verbAt = (name: string) => args.indexOf(name);
      const verb = ["list-sessions", "new-session", "kill-session", "display-message"].find(
        (n) => verbAt(n) !== -1,
      );
      const rest = verb === undefined ? args : args.slice(verbAt(verb) + 1);
      // `#undoCreate` confirms with display-message rather than with `list()`, because it runs
      // exactly when `list()` has failed. `list-omits` is about what the LIST reports, so this
      // still answers - the session is on the socket either way, which is the point of the check.
      if (verb === "display-message") {
        const target = (rest[rest.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:$/, "");
        const found = sessions.get(target);
        if (found === undefined) throw Object.assign(new Error("x"), { stderr: "can't find pane" });
        return await Promise.resolve({
          stdout: `${found.path}\u001f${String(found.created)}\n`,
          stderr: "",
        });
      }
      if (verb === "list-sessions") {
        if (mode === "list-throws") throw new Error("tmux is not answering this call");
        const shown = mode === "list-omits" ? NO_SESSIONS : sessions;
        if (shown.size === 0) throw Object.assign(new Error("x"), { stderr: "no sessions" });
        const out = [...shown.entries()]
          .map(([id, s]) => [id, s.dead ? "1" : "0", s.status, String(s.created), s.path].join(SEP))
          .join("\n");
        return await Promise.resolve({ stdout: `${out}\n`, stderr: "" });
      }
      if (verb === "new-session") {
        const id = rest[rest.indexOf("-s") + 1] ?? "";
        const path = rest[rest.indexOf("-c") + 1] ?? "";
        // `-A` is attach-if-exists, so a name already on the socket keeps its session and its
        // creation time rather than being replaced. Modelling that is what lets a test put a
        // session under our name and check the undo does not kill it.
        //
        // A genuinely new one is stamped now, not at a fixed past instant: `#undoCreate` refuses
        // to kill a session tmux reports as older than the create it is undoing.
        if (!sessions.has(id)) {
          sessions.set(id, {
            dead: false,
            status: "",
            created: Math.floor(Date.now() / 1000),
            path,
          });
        }
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
  const fail = (next: FakeMode): void => {
    mode = next;
  };
  return { tmux, sessions, die, plant, fail };
};

// Handed the socket state of an earlier registry, this builds a second one over it - which is
// what a server restart is: the sessions are there and nothing remembers anything about them.
const build = (existing?: FakeSessions) => {
  const { tmux, sessions, die, plant, fail } = fakeTmux(existing);
  const { profiles } = parseProfiles({
    claude: { command: "/bin/sh", name: "Claude Code" },
    gemini: { command: "/bin/sh", name: "Gemini CLI" },
  });
  const allowlist = new CwdAllowlist(["/workspace/agentdeck", "/workspace/web"]);
  return { registry: new Registry(tmux, profiles, allowlist), sessions, die, plant, fail };
};

void describe("adopting a session that outlived the process which created it", () => {
  // m2/session-metadata-survives-restart.
  const restart = (sessions: FakeSessions): Registry => build(sessions).registry;

  void test("the survivor is listed again, with the cwd and agent recovered from tmux", async () => {
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "gemini");

    const [adopted] = await restart(sessions).list();
    assert.equal(adopted?.id, session.id, "the survivor was not listed after a restart");
    assert.equal(adopted?.cwd, "/workspace/agentdeck", "the cwd did not come back");
    assert.equal(adopted?.agent, "gemini", "the agent did not come back");
    assert.equal(adopted?.name, "agentdeck");
  });

  void test("it says its waiting detection is dead, and the hook route agrees", async () => {
    // The secret was random and lived only in memory and in the agent's environment. Nothing here
    // can recover it and nothing can deliver a new one to a process already running, so the
    // session says so rather than reporting working/idle forever as if the hooks still worked.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);

    const [adopted] = await restarted.list();
    assert.equal(adopted?.waitingDetectionLost, true);
    assert.equal(
      restarted.secretMatches(session.id, "any-secret-at-all"),
      false,
      "a session with no secret authenticated a hook",
    );
  });

  void test("recreating it does NOT mint a secret it cannot deliver", async () => {
    // `new-session -A` attaches to the live session and injects no environment, so a fresh secret
    // would reach nobody while the session claimed a working hook path. It stays lost, loudly.
    const { registry, sessions } = build();
    await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);

    const again = await restarted.create("/workspace/agentdeck", "claude");
    assert.match(again.warning ?? "", /already running/, "this was not the reattach path");
    assert.equal(again.session.waitingDetectionLost, true);
    const [listed] = await restarted.list();
    assert.equal(listed?.waitingDetectionLost, true);
  });

  void test("a session outside the allowlist is not adopted, however it is named", async () => {
    // The hole m0/host-boundary closed. The name is exactly the one this server would derive for
    // that path, so the allowlist check on `#{session_path}` is the only thing in the way - and a
    // same-uid process owns the socket, so it is the thing that has to hold.
    const { registry, sessions, plant } = build();
    plant(sessionId("/", "claude"), "/");
    plant(sessionId("/home/someone", "claude"), "/home/someone");

    assert.deepEqual(await registry.list(), [], "a session off the allowlist became a tab");
    assert.deepEqual(await restart(sessions).list(), []);
    assert.equal(sessions.size, 2, "the server killed sessions it refuses to list");
  });

  void test("an allowlisted session whose name is not one of ours is left alone", async () => {
    // Adoption is a check, not a parse: the id has to be `sessionId(path, agent)` for a CONFIGURED
    // agent. A hand-started session in an allowlisted repo, or one naming an agent this server
    // does not have, is not something it can attach a profile to.
    const { registry, plant } = build();
    plant("agentdeck-claude-deadbeef", "/workspace/agentdeck");
    plant(sessionId("/workspace/agentdeck", "codex"), "/workspace/agentdeck");
    plant(sessionId("/workspace/web", "claude"), "/workspace/agentdeck");

    assert.deepEqual(await registry.list(), []);
  });

  void test("a session tmux reports with no path at all is not adopted", async () => {
    // `#{session_path}` is the whole of what adoption recovers, so an entry without one has
    // nothing to check against the allowlist and nothing to derive an id from. It is left alone
    // rather than defaulted to anything.
    const { registry, sessions, plant } = build();
    plant(sessionId("", "claude"), "");

    assert.deepEqual(await registry.list(), []);
    assert.equal(sessions.size, 1, "the server killed a session it refuses to list");
  });

  void test("an adopted session that has exited still says its waiting detection is dead", async () => {
    // The flag is about the hook path, not about being alive: a corpse that is listed at all is
    // listed with the same warning, so nothing reading the list has to special-case it.
    const { registry, sessions, die } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);
    die(session.id, "exited");

    const [adopted] = await restarted.list();
    assert.equal(adopted?.state, "exited");
    assert.equal(adopted?.waitingDetectionLost, true);
  });

  void test("only restarting the AGENT brings waiting detection back", async () => {
    // The sentence the item refuses to smooth over, as an assertion. Adoption recovers the tab and
    // not the hook path; recreating the session reattaches to the same process and so recovers
    // nothing either (above). What ends the loss is the agent itself going away: a session killed
    // and started again is a NEW process, started with a secret this registry minted and can
    // therefore check, and it drops the flag.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);
    assert.equal((await restarted.list())[0]?.waitingDetectionLost, true);

    await restarted.close(session.id);
    const fresh = await restarted.create("/workspace/agentdeck", "claude");
    assert.equal(fresh.session.id, session.id, "the id is not stable across the agent restart");
    assert.equal(fresh.warning, undefined, "this was a reattach, not a fresh process");
    assert.equal(
      fresh.session.waitingDetectionLost,
      undefined,
      "a freshly started agent is still reported as having lost its hook path",
    );
    assert.equal((await restarted.list())[0]?.waitingDetectionLost, undefined);
  });

  void test("a corpse from before the restart survives reap at boot, and a human can still close it", async () => {
    // The exit report is the whole point. An agent that died while the server was down leaves a
    // pane whose scrollback says why, and `reap()` at boot runs before the listener is open - so
    // killing it would delete the answer before any client could ever see it, and take the
    // `tmux attach` recovery path with it. It stays listed as `exited` until a human closes it.
    const { registry, sessions, die } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    die(session.id, "1");
    const restarted = restart(sessions);

    assert.deepEqual(await restarted.reap(), [], "the adopted corpse was reaped at boot");
    const [listed] = await restarted.list();
    assert.equal(listed?.id, session.id, "the corpse is no longer listed");
    assert.equal(listed?.state, "exited");
    assert.equal(listed?.exitCode, 1, "the exit code did not survive the restart");

    await restarted.close(session.id);
    assert.equal(sessions.size, 0, "closing an adopted corpse did not kill it");
  });

  void test("a corpse this process watched exit is still reaped at boot", async () => {
    // The other half: the secret is the marker for "we started it and saw it die", and reaping
    // those is what keeps a restart from accumulating dead panes forever.
    const { registry, sessions, die } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    die(session.id, "1");

    assert.deepEqual(await registry.reap(), [session.id], "our own corpse was not reaped");
    assert.equal(sessions.size, 0);
  });
});

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

  void test("a dead session left by a previous run is replaced, not reported as already running", async () => {
    // The restart case. `remain-on-exit on` keeps an exited session on the socket, and `#meta` is
    // memory only - so after a restart `list()` cannot see it and `reap()` at boot cannot clear
    // it. Without this the next create attaches to the corpse and answers "already running" with
    // a tab pinned at `exited` and no agent started.
    const { registry, die, sessions } = build();
    const first = await registry.create("/workspace/agentdeck", "claude");
    die(first.session.id, "exited");

    // A fresh Registry is the restart: same tmux socket, no remembered metadata.
    const restarted = new Registry(
      fakeTmux(sessions).tmux,
      parseProfiles({ claude: { command: "/bin/sh", name: "Claude Code" } }).profiles,
      new CwdAllowlist(["/workspace/agentdeck"]),
    );
    const second = await restarted.create("/workspace/agentdeck", "claude");

    assert.equal(second.warning, undefined, "the corpse was reported as a running session");
    assert.equal(second.session.state, "idle", "the new tab is pinned at the dead pane's state");
    assert.equal((await restarted.list()).length, 1);
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

// m0/create-500's second property, over the modelled tmux: a create that cannot finish takes back
// the session it made. The real-binary version of this lives in src/create-500.test.ts; these are
// the branches that are hard to provoke against a real tmux - a list that succeeds but omits the
// session, and the attach path, where killing would destroy somebody else's running agent.
void describe("a create that cannot finish leaves no orphan", () => {
  void test("the session is killed when the list after the create throws", async () => {
    // The shape of the reported bug, minus its cause: tmux made the session, the call could not
    // report it, and before m0/create-500 the agent stayed running with nobody holding its id.
    const { registry, sessions, fail } = build();
    fail("list-throws");
    await assert.rejects(async () => await registry.create("/workspace/agentdeck", "claude"));
    assert.deepEqual([...sessions.keys()], []);
  });

  void test("the session is killed when the list comes back without it", async () => {
    // The other branch, and the one the 500 actually came out of: list() succeeded and simply did
    // not contain what had just been created.
    const { registry, sessions, fail } = build();
    fail("list-omits");
    await assert.rejects(
      async () => await registry.create("/workspace/agentdeck", "claude"),
      /was created but tmux does not list it/,
    );
    assert.deepEqual([...sessions.keys()], []);
  });

  void test("a retry after a failed create succeeds rather than colliding with its own leftovers", async () => {
    // Undoing the create has to clear the remembered metadata too. If it did not, the id would
    // still be in `#meta` and the next create would report an attach to a session that no longer
    // exists - a failure that outlives the failure.
    const { registry, sessions, fail } = build();
    fail("list-throws");
    await assert.rejects(async () => await registry.create("/workspace/agentdeck", "claude"));
    fail("ok");
    const result = await registry.create("/workspace/agentdeck", "claude");
    assert.equal(result.warning, undefined);
    assert.equal(result.session.state, "idle");
    assert.deepEqual([...sessions.keys()], [result.session.id]);
  });

  void test("a session under our name that we did not just create is not killed", async () => {
    // `attached === false` is not a warrant on its own: it comes from a `has()` that ran BEFORE
    // `new-session -A`, and the name is `sessionId(cwd, agent)` - computable offline by anything
    // running as this user, and readable from GET /api/cwds and GET /api/agents by any client.
    // Something that puts that name on the socket inside the window makes `-A` attach to ITS
    // session while `attached` still reports false, and the undo would then kill it.
    const { registry, sessions, plant, fail } = build();
    const id = sessionId("/workspace/agentdeck", "claude");
    plant(id, "/workspace/agentdeck");
    // Older than any create this call could have made.
    const planted = sessions.get(id);
    if (planted !== undefined) sessions.set(id, { ...planted, created: 1_700_000_000 });

    // The list omits it, so `has()` reports no session and `-A` attaches to the planted one while
    // `attached` still comes back false - which is exactly the window the warrant was too wide for.
    fail("list-omits");
    await assert.rejects(async () => await registry.create("/workspace/agentdeck", "claude"));
    assert.ok(sessions.has(id), "a session this call did not create was killed by its undo");
  });

  void test("an ATTACH that cannot finish leaves the running agent alone", async () => {
    // The line between taking back your own mess and destroying somebody's work. The second call
    // created nothing - tmux handed back a session that was already running - so a failure after
    // that point must not kill it. Getting this wrong turns a transient tmux error into hours of
    // an agent's work ended by a request that only wanted to look at it.
    const { registry, sessions, fail } = build();
    const first = await registry.create("/workspace/agentdeck", "claude");
    fail("list-throws");
    await assert.rejects(async () => await registry.create("/workspace/agentdeck", "claude"));
    assert.deepEqual([...sessions.keys()], [first.session.id]);
  });
});
