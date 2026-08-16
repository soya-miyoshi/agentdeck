import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { CwdNotAllowedError, Registry, secretFor, UnknownAgentError } from "./registry.ts";
import { sessionId } from "./session-id.ts";
import { Tmux } from "./tmux.ts";

const SEP = "\u001f";

/** A tmux stand-in that models sessions, so create/list/kill can be exercised as a whole. */
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
      // One invocation chains several commands and the interesting one is not always first: a create
      // is preceded by the `set-option -g update-environment` that keeps secrets out of argv.
      const verbAt = (name: string) => args.indexOf(name);
      const verb = ["list-sessions", "new-session", "kill-session", "display-message"].find(
        (n) => verbAt(n) !== -1,
      );
      const rest = verb === undefined ? args : args.slice(verbAt(verb) + 1);
      // `#undoCreate` confirms with display-message because it runs exactly when `list()` failed.
      // `list-omits` is about the LIST, so this still answers - the session is on the socket.
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
        // `-A` keeps an existing session and its creation time, which is what lets a test plant one
        // under our name. A new one is stamped now, since the undo refuses anything older.
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
  return {
    registry: new Registry(tmux, profiles, allowlist, "test-secret-key"),
    sessions,
    die,
    plant,
    fail,
  };
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

  void test("its waiting detection SURVIVES the restart, because the secret is derived", async () => {
    // What used to mute every tab: a random secret held in memory and in the agent's environment,
    // which a new process could neither learn nor replace. Derived, it comes back.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);

    const [adopted] = await restarted.list();
    assert.equal(adopted?.waitingDetectionLost, undefined, "the tab was muted by a restart");
    assert.equal(
      restarted.secretMatches(session.id, secretFor("test-secret-key", session.id)),
      true,
      "the restarted process cannot authenticate the hook its own agent will send",
    );
    // Still a check, not a rubber stamp: the wrong secret is refused.
    assert.equal(restarted.secretMatches(session.id, "any-secret-at-all"), false);
  });

  void test("an agent holding a secret from before derivation is reported as muted, not as healthy", async () => {
    // The one population derivation cannot help - started when the secret was random - and it must
    // not look healthy, so the first refused hook marks it.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);
    assert.equal((await restarted.list())[0]?.waitingDetectionLost, undefined);

    assert.equal(restarted.secretMatches(session.id, "a-secret-from-the-old-scheme"), false);
    assert.equal(
      (await restarted.list())[0]?.waitingDetectionLost,
      true,
      "a session whose hooks are refused is still reported as able to report waiting",
    );
  });

  void test("recreating it reattaches to the same agent and the hook path still works", async () => {
    // `-A` attaches to the live session and injects no environment, which used to lose the secret.
    // The derived one is the SAME string the agent holds, so nothing needs delivering.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);

    const again = await restarted.create("/workspace/agentdeck", "claude");
    assert.match(again.warning ?? "", /already running/, "this was not the reattach path");
    assert.equal(again.session.waitingDetectionLost, undefined);
    assert.equal(
      restarted.secretMatches(session.id, secretFor("test-secret-key", session.id)),
      true,
    );
  });

  void test("a session outside the allowlist is not adopted, however it is named", async () => {
    // The name is exactly the one this server would derive for that path, so the check on
    // `#{session_path}` is the only thing in the way - and a same-uid process owns the socket.
    const { registry, sessions, plant } = build();
    plant(sessionId("/", "claude"), "/");
    plant(sessionId("/home/someone", "claude"), "/home/someone");

    assert.deepEqual(await registry.list(), [], "a session off the allowlist became a tab");
    assert.deepEqual(await restart(sessions).list(), []);
    assert.equal(sessions.size, 2, "the server killed sessions it refuses to list");
  });

  void test("an allowlisted session whose name is not one of ours is left alone", async () => {
    // Adoption is a check rather than a parse: the id must be `sessionId(path, agent)` for a
    // CONFIGURED agent, or there is no profile to attach to it.
    const { registry, plant } = build();
    plant("agentdeck-claude-deadbeef", "/workspace/agentdeck");
    plant(sessionId("/workspace/agentdeck", "codex"), "/workspace/agentdeck");
    plant(sessionId("/workspace/web", "claude"), "/workspace/agentdeck");

    assert.deepEqual(await registry.list(), []);
  });

  void test("a session tmux reports with no path at all is not adopted", async () => {
    // `#{session_path}` is the whole of what adoption recovers, so an entry without one has nothing
    // to check and nothing to derive from. Left alone rather than defaulted.
    const { registry, sessions, plant } = build();
    plant(sessionId("", "claude"), "");

    assert.deepEqual(await registry.list(), []);
    assert.equal(sessions.size, 1, "the server killed a session it refuses to list");
  });

  void test("an adopted corpse is listed as exited, and reap at boot leaves it alone", async () => {
    // `reap()` used to ask "has a secret?" for "did this process start it?", and the secret is now
    // always present - so left that way, reaping at boot would destroy every adopted corpse.
    const { registry, sessions, die } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);
    die(session.id, "exited");

    const [adopted] = await restarted.list();
    assert.equal(adopted?.state, "exited");
    assert.deepEqual(await restarted.reap(), [], "reap killed a corpse this process did not start");
    assert.equal((await restarted.list()).length, 1, "the adopted corpse was destroyed");
  });

  void test("restarting the AGENT clears a loss that was detected", async () => {
    // A session marked deaf by a refused hook gets its flag back when the agent goes away and a new
    // one starts, because the new process is handed the derived secret at creation.
    const { registry, sessions } = build();
    const { session } = await registry.create("/workspace/agentdeck", "claude");
    const restarted = restart(sessions);
    // Listed first, because `#meta` is populated by adoption and a hook for a session this process
    // has never listed is refused without marking anything. The real server lists at boot.
    await restarted.list();
    restarted.secretMatches(session.id, "a-secret-from-the-old-scheme");
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
    // An agent that died while the server was down leaves a pane whose scrollback says why, and
    // `reap()` runs before the listener opens - so killing it deletes the answer unseen.
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

  void test("two DIFFERENT agents in one tree produce two sessions and no warning", async () => {
    // Allowed and silent since plan 004: the neighbour is usually the operator's own shell, so the
    // warning fired mostly on the legitimate case. The picker still shows what is live.
    const { registry } = build();
    await registry.create("/workspace/agentdeck", "claude");
    const second = await registry.create("/workspace/agentdeck", "gemini");

    assert.equal(second.warning, undefined, "a neighbouring session warned");
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
    // `remain-on-exit on` keeps an exited session on the socket, so without this the next create
    // attaches to the corpse and answers "already running" with no agent started.
    const { registry, die, sessions } = build();
    const first = await registry.create("/workspace/agentdeck", "claude");
    die(first.session.id, "exited");

    // A fresh Registry is the restart: same tmux socket, no remembered metadata.
    const restarted = new Registry(
      fakeTmux(sessions).tmux,
      parseProfiles({ claude: { command: "/bin/sh", name: "Claude Code" } }).profiles,
      new CwdAllowlist(["/workspace/agentdeck"]),
      "test-secret-key",
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
    // The boundary was one-way: a session not listed, attached or reaped was still killable by
    // `DELETE /api/sessions/:id`, along with everything running in it.
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
    // The name is a pure function of two knowable things, so anything running as this user can
    // recreate ours with `-c /` - and enforcing against the remembered cwd made that a tab.
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

// A create that cannot finish takes back the session it made. These are the branches hard to
// provoke against a real tmux: a list that omits the session, and the attach path.
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
    // Undoing has to clear the remembered metadata too, or the next create reports an attach to a
    // session that no longer exists - a failure outliving the failure.
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
    // `attached === false` comes from a `has()` that ran BEFORE `-A`, and the name is computable
    // offline - so something planting it inside that window is killed by the undo.
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
    // The line between taking back your own mess and destroying somebody's work: the second call
    // created nothing, so a failure after it must not kill what was already running.
    const { registry, sessions, fail } = build();
    const first = await registry.create("/workspace/agentdeck", "claude");
    fail("list-throws");
    await assert.rejects(async () => await registry.create("/workspace/agentdeck", "claude"));
    assert.deepEqual([...sessions.keys()], [first.session.id]);
  });
});
