import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isEmptyTmux, isMissingSession, Tmux } from "./tmux.ts";

const SEP = "\u001f";

/** A fake tmux that records what it was asked and replays canned stdout. */
const fake = (responses: Record<string, string | Error> = {}) => {
  const calls: string[][] = [];
  const tmux = new Tmux({
    socket: "test",
    exec: async (args) => {
      calls.push(args);
      const key = args[0] ?? "";
      const response = responses[key];
      if (response instanceof Error) throw response;
      return await Promise.resolve({ stdout: response ?? "", stderr: "" });
    },
  });
  return { tmux, calls };
};

const line = (id: string, dead: string, status: string, created = "1700000000") =>
  [id, dead, status, created].join(SEP);

void describe("listing sessions", () => {
  void test("reads the fields the state machine needs", async () => {
    const { tmux } = fake({ "list-sessions": `${line("a-claude-1", "0", "")}\n` });
    const [session] = await tmux.list();
    assert.equal(session?.id, "a-claude-1");
    assert.equal(session?.dead, false);
    assert.equal(session?.startedAt, 1_700_000_000_000);
  });

  void test("a dead pane reports its exit code", async () => {
    const { tmux } = fake({ "list-sessions": `${line("a-claude-1", "1", "137")}\n` });
    const [session] = await tmux.list();
    assert.equal(session?.dead, true);
    assert.equal(session?.exitCode, 137);
  });

  void test("a live pane has no exit code, rather than exit code zero", async () => {
    // tmux leaves dead_status blank for a live pane. Reporting "exited 0" for a running agent
    // would be a confidently wrong answer, which is the one output this design refuses.
    const { tmux } = fake({ "list-sessions": `${line("a-claude-1", "0", "")}\n` });
    const [session] = await tmux.list();
    assert.equal(session?.exitCode, undefined);
  });

  void test("no server running is an empty list, not a throw", async () => {
    // The normal state at boot. An empty list and a dead server are both non-zero exits from
    // tmux, and only one of them is a failure.
    const error = Object.assign(new Error("exited"), {
      stderr: "no server running on /tmp/tmux-1000/test",
    });
    const { tmux } = fake({ "list-sessions": error });
    assert.deepEqual(await tmux.list(), []);
  });

  void test("no sessions is an empty list too", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "no sessions" });
    const { tmux } = fake({ "list-sessions": error });
    assert.deepEqual(await tmux.list(), []);
  });

  void test("and so is the wording tmux 3.7b on macOS actually uses", async () => {
    // Observed, not guessed: running the server for real crashed startup here, because this is
    // what tmux says when the socket file does not exist and neither documented phrase appears.
    const error = Object.assign(new Error("Command failed"), {
      stderr: "error connecting to /private/tmp/tmux-501/agentdeck (No such file or directory)\n",
    });
    const { tmux } = fake({ "list-sessions": error });
    assert.deepEqual(await tmux.list(), []);
  });

  void test("any other failure propagates", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "permission denied" });
    const { tmux } = fake({ "list-sessions": error });
    await assert.rejects(async () => await tmux.list());
  });
});

void describe("create or attach", () => {
  void test("creates when absent, and sets remain-on-exit", async () => {
    const { tmux, calls } = fake({ "list-sessions": "" });
    const { attached } = await tmux.createOrAttach(
      "web-claude-abc",
      "/workspace/web",
      "claude",
      [],
      {},
    );
    assert.equal(attached, false);

    const create = calls.find((c) => c[0] === "new-session");
    assert.ok(create, "no new-session call");
    assert.ok(create.includes("-A"), "-A is what makes a restart reattach instead of orphaning");
    assert.ok(create.includes("-d"), "-d keeps the server from attaching itself to the session");
    assert.deepEqual(create.slice(create.indexOf("--")), ["--", "claude"]);

    const option = calls.find((c) => c[0] === "set-option");
    assert.ok(option, "remain-on-exit was never set");
    assert.deepEqual(option.slice(-2), ["remain-on-exit", "on"]);
  });

  void test("reports attached when the session already exists, and creates nothing", async () => {
    // The deliberate collision: same cwd, same agent. Handing back the running session is the
    // better failure, because a second identical agent in one tree is usually a forgotten tab.
    const { tmux, calls } = fake({ "list-sessions": `${line("web-claude-abc", "0", "")}\n` });
    const { attached } = await tmux.createOrAttach(
      "web-claude-abc",
      "/workspace/web",
      "claude",
      [],
      {},
    );
    assert.equal(attached, true);
    assert.equal(
      calls.some((c) => c[0] === "new-session"),
      false,
    );
  });

  void test("passes environment per session rather than through our own", async () => {
    // One session's secret must never become another's.
    const { tmux, calls } = fake({ "list-sessions": "" });
    await tmux.createOrAttach("s", "/w", "claude", [], { AGENTDECK_SECRET: "abc" });
    const create = calls.find((c) => c[0] === "new-session");
    assert.ok(create?.includes("AGENTDECK_SECRET=abc"));
  });

  void test("the command is passed after --, so an argument cannot become a tmux flag", () => {
    // The client names a profile id and the server owns what runs, but the args still come from
    // config, and `--` is what keeps a leading-dash argument from being read as a tmux option.
    const { tmux, calls } = fake({ "list-sessions": "" });
    return tmux.createOrAttach("s", "/w", "claude", ["--dangerous"], {}).then(() => {
      const create = calls.find((c) => c[0] === "new-session");
      const afterSeparator = create?.slice((create.indexOf("--") ?? 0) + 1);
      assert.deepEqual(afterSeparator, ["claude", "--dangerous"]);
    });
  });
});

void describe("ensuring a server exists", () => {
  void test("starts one and turns exit-empty off", async () => {
    // exit-empty defaults to ON, so a server holding no sessions terminates - which is every
    // server at boot. `start-server` reports success either way, so this is invisible until
    // something tries to use the server that is already gone.
    const { tmux, calls } = fake();
    await tmux.ensureServer();
    // One invocation, not two: as separate calls the empty server exits between them and
    // set-option fails with "no server running". Observed, not theorised.
    assert.equal(calls.length, 1, "start-server and set-option must not be separate calls");
    assert.deepEqual(calls[0], ["start-server", ";", "set-option", "-g", "exit-empty", "off"]);
  });
});

void describe("kill is idempotent", () => {
  void test("a missing session is the desired end state, not a failure", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "can't find session: gone" });
    const { tmux } = fake({ "kill-session": error });
    await assert.doesNotReject(async () => await tmux.kill("gone"));
  });

  void test("a real failure still propagates", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "permission denied" });
    const { tmux } = fake({ "kill-session": error });
    await assert.rejects(async () => await tmux.kill("s"));
  });
});

void describe("capture and repaint", () => {
  void test("capture-pane asks for escapes and a bounded history", async () => {
    // -e keeps the ANSI escapes, which is what makes tmux usable as the scrollback store.
    const { tmux, calls } = fake({ "capture-pane": "old output\n" });
    const out = await tmux.captureHistory("s", 2000);
    assert.equal(out, "old output\n");
    const call = calls[0];
    assert.ok(call, "capture-pane was never called");
    assert.ok(call.includes("-e"));
    assert.ok(call.includes("-p"));
    assert.deepEqual(call.slice(call.indexOf("-S"), call.indexOf("-S") + 2), ["-S", "-2000"]);
  });

  void test("capturing a session that has gone returns nothing rather than throwing", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "can't find session: s" });
    const { tmux } = fake({ "capture-pane": error });
    assert.equal(await tmux.captureHistory("s", 100), "");
  });

  void test("refresh asks tmux to repaint into the stream we already read", async () => {
    const { tmux, calls } = fake({ "refresh-client": "" });
    await tmux.refresh("s");
    assert.ok(calls[0]?.includes("-R"));
  });
});

void describe("error classification", () => {
  void test("distinguishes an empty server from a missing session", () => {
    const empty = { stderr: "no server running on /tmp/x" };
    const missing = { stderr: "can't find session: abc" };
    assert.equal(isEmptyTmux(empty), true);
    assert.equal(isMissingSession(empty), false);
    assert.equal(isMissingSession(missing), true);
    assert.equal(isEmptyTmux(missing), false);
  });

  void test("survives a non-object error", () => {
    assert.equal(isEmptyTmux("boom"), false);
    assert.equal(isMissingSession(undefined), false);
  });
});
