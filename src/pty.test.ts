import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { IPty } from "node-pty";

import { SessionPty } from "./pty.ts";
import { BASE_ENV_NAMES } from "./tmux.ts";

/** A fake PTY that records what it was told and lets a test drive its callbacks. */
const fakePty = () => {
  const written: string[] = [];
  const resized: { cols: number; rows: number }[] = [];
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  let killed = 0;
  let resizeThrows = false;

  const pty = {
    onData: (cb: (data: string) => void) => {
      onData = cb;
      return { dispose: () => undefined };
    },
    onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => {
      onExit = cb;
      return { dispose: () => undefined };
    },
    write: (data: string) => written.push(data),
    resize: (cols: number, rows: number) => {
      if (resizeThrows) throw new Error("the process has gone");
      resized.push({ cols, rows });
    },
    kill: () => {
      killed++;
    },
  } as unknown as IPty;

  return {
    pty,
    written,
    resized,
    killed: () => killed,
    emit: (data: string) => onData?.(data),
    exit: (exitCode: number) => onExit?.({ exitCode }),
    breakResize: () => (resizeThrows = true),
  };
};

const build = () => {
  const fake = fakePty();
  const spawned: {
    file: string;
    args: string[];
    options: { cols: number; rows: number; env: Record<string, string> };
  }[] = [];
  const session = new SessionPty({
    socket: "test",
    sessionId: "web-claude-abc",
    cols: 80,
    rows: 24,
    spawnPty: (file, args, options) => {
      spawned.push({ file, args, options });
      return fake.pty;
    },
  });
  return { session, fake, spawned };
};

void describe("what gets spawned", () => {
  void test("attaches to an existing session rather than creating one", () => {
    // Creating is the registry's job and has already happened. Conflating them would mean the
    // thing that reads output also decides what runs, and a reattach after a crash would try to
    // create a session that is already there.
    const { spawned } = build();
    const call = spawned[0];
    assert.equal(call?.file, "tmux");
    assert.ok(call.args.includes("attach-session"));
    assert.equal(call.args.includes("new-session"), false);
  });

  void test("passes -d, so tmux does not size the pane over clients we do not control", () => {
    // Without -d a second attach makes tmux take the minimum over ALL its clients, including
    // stale ones, silently overriding our own minimum-over-attached-browsers rule.
    const { spawned } = build();
    assert.ok(spawned[0]?.args.includes("-d"));
  });

  void test("names the socket and the session", () => {
    const { spawned } = build();
    const args = spawned[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 2), ["-L", "test"]);
    // Exact: `-t name` would attach to whatever session shares a prefix with a stale id.
    assert.equal(args.at(-1), "=web-claude-abc");
  });

  void test("opens at the size it was given", () => {
    const { spawned } = build();
    assert.equal(spawned[0]?.options.cols, 80);
    assert.equal(spawned[0]?.options.rows, 24);
  });

  void test("attaches with a built environment, not this process's", () => {
    // A tmux client is a way INTO a session's environment: `update-environment` copies named
    // variables from the attaching client into the session it attaches to. That option is emptied
    // on the server, and this is the other end of the same rule.
    const { spawned } = build();
    const names = Object.keys(spawned[0]?.options.env ?? {});
    assert.ok(names.length > 0, "the attach inherited this process's whole environment");
    for (const name of names)
      assert.ok(BASE_ENV_NAMES.includes(name), `${name} is not on the list`);
  });
});

void describe("output reaches the stream", () => {
  void test("bytes are counted as bytes, not as characters", () => {
    // seq is a byte count, and the counter has to agree with what the socket will carry.
    const { session, fake } = build();
    fake.emit("日本語");
    assert.equal(session.stream.buffer.headSeq, 9);
  });

  void test("sustained output makes the session working", () => {
    const { session, fake } = build();
    fake.emit("x".repeat(200));
    assert.equal(session.stream.state(), "working");
  });

  void test("output flows with nobody attached", () => {
    // The unwatched session is the one most likely to need you, so its status must keep working
    // with zero browser clients.
    const { session, fake } = build();
    assert.equal(session.stream.attachedCount, 0);
    fake.emit("y".repeat(200));
    assert.equal(session.stream.state(), "working");
  });
});

void describe("exit is definitive", () => {
  void test("the exit code reaches the stream", () => {
    const { session, fake } = build();
    fake.exit(137);
    assert.equal(session.stream.state(), "exited");
    assert.equal(session.stream.exitCode, 137);
  });

  void test("bytes draining out of a dead pane do not resurrect it", () => {
    const { session, fake } = build();
    fake.exit(1);
    fake.emit("z".repeat(500));
    assert.equal(session.stream.state(), "exited");
  });

  void test("exit code zero is still an exit", () => {
    // A clean finish must be distinguishable from a live session, not folded into idle.
    const { session, fake } = build();
    fake.exit(0);
    assert.equal(session.stream.state(), "exited");
    assert.equal(session.stream.exitCode, 0);
  });
});

void describe("input, resize and disposal", () => {
  void test("input is passed through untouched", () => {
    const { session, fake } = build();
    session.write("ls -la\r");
    assert.deepEqual(fake.written, ["ls -la\r"]);
  });

  void test("resize reaches the pty", () => {
    const { session, fake } = build();
    session.resize(120, 40);
    assert.deepEqual(fake.resized, [{ cols: 120, rows: 40 }]);
  });

  void test("a resize racing a dying agent does not throw", () => {
    // node-pty throws once the process has gone. Failing here would take down the socket that was
    // about to report the exit.
    const { session, fake } = build();
    fake.breakResize();
    assert.doesNotThrow(() => session.resize(80, 24));
  });

  void test("dispose detaches without killing the agent", () => {
    const { session, fake } = build();
    session.dispose();
    assert.equal(fake.killed(), 1);
    assert.equal(session.disposed, true);
  });

  void test("dispose is idempotent, and silences later writes", () => {
    const { session, fake } = build();
    session.dispose();
    session.dispose();
    session.write("too late");
    session.resize(10, 10);
    assert.equal(fake.killed(), 1);
    assert.deepEqual(fake.written, []);
    assert.deepEqual(fake.resized, []);
  });
});
