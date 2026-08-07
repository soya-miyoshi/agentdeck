import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { Hub } from "./hub.ts";
import type { SessionPty } from "./pty.ts";
import { Registry } from "./registry.ts";
import { SessionStream } from "./stream.ts";
import { Tmux } from "./tmux.ts";

const SEP = "\u001f";

const fakeTmux = () => {
  const sessions = new Map<string, { dead: boolean; status: string; path: string }>();
  const tmux = new Tmux({
    socket: "test",
    exec: async (args) => {
      // The interesting command is not always first: a create is preceded by the
      // `set-option -g update-environment <names>` that keeps the values out of argv.
      const verb = ["list-sessions", "new-session", "kill-session", "capture-pane"].find((n) =>
        args.includes(n),
      );
      const rest = verb === undefined ? args : args.slice(args.indexOf(verb) + 1);
      if (verb === "list-sessions") {
        if (sessions.size === 0) throw Object.assign(new Error("x"), { stderr: "no sessions" });
        const out = [...sessions.entries()]
          .map(([id, s]) => [id, s.dead ? "1" : "0", s.status, "1700000000", s.path].join(SEP))
          .join("\n");
        return await Promise.resolve({ stdout: `${out}\n`, stderr: "" });
      }
      if (verb === "new-session") {
        sessions.set(rest[rest.indexOf("-s") + 1] ?? "", {
          dead: false,
          status: "",
          path: rest[rest.indexOf("-c") + 1] ?? "",
        });
      }
      if (verb === "kill-session")
        sessions.delete((rest[rest.indexOf("-t") + 1] ?? "").replace(/^=/, ""));
      if (verb === "capture-pane")
        return await Promise.resolve({ stdout: "history\n", stderr: "" });
      return await Promise.resolve({ stdout: "", stderr: "" });
    },
  });
  const die = (id: string, status: string) => {
    const existing = sessions.get(id);
    if (existing) sessions.set(id, { ...existing, dead: true, status });
  };
  const plant = (id: string, path: string) => sessions.set(id, { dead: false, status: "", path });
  return { tmux, sessions, die, plant };
};

/** A stand-in for the live attachment, so the hub is tested without spawning anything. */
const fakePty = (sessionId: string) => {
  const stream = new SessionStream({ sessionId });
  const written: string[] = [];
  const resized: { cols: number; rows: number }[] = [];
  let disposed = false;
  return {
    stream,
    sessionId,
    written,
    resized,
    write: (data: string) => written.push(data),
    resize: (cols: number, rows: number) => resized.push({ cols, rows }),
    dispose: () => (disposed = true),
    get disposed() {
      return disposed;
    },
  } as unknown as SessionPty & { written: string[]; resized: { cols: number; rows: number }[] };
};

const build = () => {
  const { tmux, die, sessions, plant } = fakeTmux();
  const { profiles } = parseProfiles({ claude: { command: "/bin/sh" } });
  const allowlist = new CwdAllowlist(["/workspace/a", "/workspace/b"]);
  const registry = new Registry(tmux, profiles, allowlist);
  const created: string[] = [];
  const ptys = new Map<string, ReturnType<typeof fakePty>>();
  const hub = new Hub({
    tmux,
    registry,
    socket: "test",
    createPty: (sessionId) => {
      created.push(sessionId);
      const pty = fakePty(sessionId);
      ptys.set(sessionId, pty);
      return pty;
    },
  });
  return { hub, registry, tmux, die, created, ptys, sessions, plant };
};

void describe("the allowlist bounds the session set, not only what can be created", () => {
  void test("a session on the socket that agentdeck did not start is never attached", async () => {
    // The socket is /tmp/tmux-<uid>/agentdeck and every process running as this user can write
    // it, so `tmux -L agentdeck new-session -d -c / -- /bin/sh` is otherwise a tab the phone can
    // type into within one sync. agentdeck knows a session's directory only for the sessions it
    // started, so an unknown one is outside the allowlist by definition.
    const { hub, registry, tmux, created } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    await tmux.createOrAttach("stranger", "/", "/bin/sh", [], {});
    await hub.sync();
    assert.deepEqual(created, [session.id], "the hub adopted a session nobody allowed");
    assert.equal(hub.size, 1);
    assert.equal(hub.streamFor("stranger"), undefined);
  });

  void test("and it is not on the session list either, so no tab claims it", async () => {
    // A tab with no stream is the confidently-wrong output this design refuses, so the list and
    // the hub have to agree - which they do by having one filter, in Registry.list.
    const { registry, tmux } = build();
    await registry.create("/workspace/a", "claude");
    await tmux.createOrAttach("stranger", "/", "/bin/sh", [], {});
    assert.deepEqual(
      (await registry.list()).map((s) => s.id.startsWith("a-")),
      [true],
    );
  });
});

void describe("reconciling against tmux", () => {
  void test("attaches to a session it has not seen", async () => {
    const { hub, registry, created } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    await hub.sync();
    assert.deepEqual(created, [session.id]);
    assert.equal(hub.size, 1);
  });

  void test("syncing twice does not attach twice", async () => {
    const { hub, registry, created } = build();
    await registry.create("/workspace/a", "claude");
    await hub.sync();
    await hub.sync();
    assert.equal(created.length, 1);
  });

  void test("lets go of a session tmux no longer has, and disposes its attachment", async () => {
    const { hub, registry, ptys } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    await hub.sync();
    await registry.close(session.id);
    await hub.sync();

    assert.equal(hub.size, 0);
    assert.equal(ptys.get(session.id)?.disposed, true);
    assert.equal(hub.streamFor(session.id), undefined);
  });

  void test("does not attach to a session that has already exited", async () => {
    // Attaching to a dead pane produces a stream that never carries anything, and the exit code
    // is already on the list.
    const { hub, registry, die, created } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    die(session.id, "1");
    await hub.sync();
    assert.deepEqual(created, []);
    assert.equal(hub.size, 0);
  });

  void test("a session that cannot be attached does not take the server down", async () => {
    // The first real run died exactly here: a node-pty spawn threw, nothing caught it, and every
    // OTHER session went with the process. One bad session is a worse tab, not a lost server.
    const { tmux } = fakeTmux();
    const { profiles } = parseProfiles({ claude: { command: "/bin/sh" } });
    const allowlist = new CwdAllowlist(["/workspace/a", "/workspace/b"]);
    const registry = new Registry(tmux, profiles, allowlist);
    const attached: string[] = [];
    const hub = new Hub({
      tmux,
      registry,
      socket: "test",
      createPty: (sessionId) => {
        if (sessionId.startsWith("a-")) throw new Error("posix_spawnp failed.");
        attached.push(sessionId);
        return fakePty(sessionId);
      },
    });

    const bad = await registry.create("/workspace/a", "claude");
    const good = await registry.create("/workspace/b", "claude");
    await assert.doesNotReject(async () => await hub.sync());

    assert.deepEqual(attached, [good.session.id], "the healthy session must still be attached");
    assert.equal(hub.streamFor(bad.session.id), undefined);
    assert.equal(hub.size, 1);
  });

  void test("tmux is still the truth for every session inside the boundary", async () => {
    // The hub keeps no set of its own: it attaches to what tmux reports, filtered to the
    // allowlist, so a session it was never told about individually still appears. What changed on
    // 2026-08-07 is only the filter - a session whose directory nobody allowed is not adopted,
    // which is the case the test above covers.
    const { hub, registry, created } = build();
    await registry.create("/workspace/a", "claude");
    await registry.create("/workspace/b", "claude");
    await hub.sync();
    assert.equal(created.length, 2);
  });
});

void describe("state flows back to the session list", () => {
  void test("an idle stream reports idle", async () => {
    const { hub, registry } = build();
    await registry.create("/workspace/a", "claude");
    await hub.sync();
    const [listed] = await registry.list();
    assert.equal(listed?.state, "idle");
  });

  void test("output makes the listed session working", async () => {
    // This is the field the tab UI exists to show, so it has to come from what the stream
    // observed rather than from a default set at creation.
    const { hub, registry, ptys } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    await hub.sync();

    ptys.get(session.id)?.stream.write(Buffer.alloc(200, 0x61));
    await hub.sync();

    const [listed] = await registry.list();
    assert.equal(listed?.state, "working");
  });

  void test("a dead session reports exited regardless of what any stream thinks", async () => {
    const { hub, registry, die } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    await hub.sync();
    die(session.id, "137");
    await hub.sync();

    const [listed] = await registry.list();
    assert.equal(listed?.state, "exited");
    assert.equal(listed?.exitCode, 137);
  });
});

void describe("routing to the right session", () => {
  void test("input and resize reach only the session addressed", async () => {
    const { hub, registry, ptys } = build();
    const a = await registry.create("/workspace/a", "claude");
    const b = await registry.create("/workspace/b", "claude");
    await hub.sync();

    hub.sendInput(a.session.id, "typed into a");
    hub.applyPaneSize(b.session.id, 60, 20);

    assert.deepEqual(ptys.get(a.session.id)?.written, ["typed into a"]);
    assert.deepEqual(ptys.get(b.session.id)?.written, []);
    assert.deepEqual(ptys.get(b.session.id)?.resized, [{ cols: 60, rows: 20 }]);
    assert.deepEqual(ptys.get(a.session.id)?.resized, []);
  });

  void test("input to an unknown session is dropped rather than thrown", () => {
    // A client can address a session that has just gone; that is a race, not a fault.
    const { hub } = build();
    assert.doesNotThrow(() => hub.sendInput("no-such-session", "hello"));
    assert.doesNotThrow(() => hub.applyPaneSize("no-such-session", 80, 24));
  });

  void test("scrollback comes from tmux for the session asked about", async () => {
    const { hub, registry } = build();
    const { session } = await registry.create("/workspace/a", "claude");
    await hub.sync();
    assert.equal(await hub.captureHistory(session.id, 100), "history\n");
  });
});

void describe("shutdown", () => {
  void test("disposes every attachment and forgets them", async () => {
    const { hub, registry, ptys } = build();
    const a = await registry.create("/workspace/a", "claude");
    await registry.create("/workspace/b", "claude");
    await hub.sync();

    hub.disposeAll();
    assert.equal(hub.size, 0);
    assert.equal(ptys.get(a.session.id)?.disposed, true);
  });
});
