import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { BASE_ENV_NAMES, baseEnv, isEmptyTmux, isMissingSession, Tmux } from "./tmux.ts";

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

/** Split one tmux invocation into the commands its `;` separators chain together. */
const commandsOf = (args: readonly string[]): string[][] => {
  const out: string[][] = [[]];
  for (const arg of args) {
    if (arg === ";") out.push([]);
    else out[out.length - 1]?.push(arg);
  }
  return out;
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
    // Up to the next `;`, which is where tmux's own command separator ends this command and the
    // set-option chained after it begins.
    assert.deepEqual(create.slice(create.indexOf("--"), create.indexOf(";")), ["--", "claude"]);

    assert.deepEqual(commandsOf(create)[1], [
      "set-option",
      "-t",
      "web-claude-abc",
      "remain-on-exit",
      "on",
    ]);
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

  void test("and takes every one of them back out of the session environment", async () => {
    // `-e` reaches the pane by putting the variable in the SESSION environment, where tmux keeps
    // it: `tmux -L <socket> show-environment -t <session>` would otherwise print the per-session
    // hook secret, and every API key a profile passed through, to any process running as this
    // user. tmux builds the pane's environment when new-session forks it, so unsetting in the
    // same chained invocation takes the value from the reader and not from the agent.
    const { tmux, calls } = fake({ "list-sessions": "" });
    await tmux.createOrAttach("s", "/w", "claude", [], {
      AGENTDECK_SECRET: "abc",
      ANTHROPIC_API_KEY: "sk-live",
      AGENTDECK_SESSION_ID: "s",
    });
    const create = calls.find((c) => c[0] === "new-session");
    assert.ok(create, "no new-session call");

    // One invocation, not a follow-up call: a second call is a window in which the secret is
    // readable, and a crash between the two would leave it there for the session's life.
    assert.equal(
      calls.filter((c) => c[0] === "new-session" || c[0] === "set-environment").length,
      1,
    );
    const unset = commandsOf(create)
      .filter((c) => c[0] === "set-environment")
      .map((c) => c[c.length - 1]);
    assert.deepEqual(unset.sort(), [
      "AGENTDECK_SECRET",
      "AGENTDECK_SESSION_ID",
      "ANTHROPIC_API_KEY",
    ]);
    for (const command of commandsOf(create).filter((c) => c[0] === "set-environment")) {
      // -u is unset rather than set-to-empty, and -t is the session it was just given to.
      assert.deepEqual(command.slice(0, 4), ["set-environment", "-t", "s", "-u"]);
      assert.equal(command.length, 5);
    }
  });

  void test("the command is passed after --, so an argument cannot become a tmux flag", () => {
    // The client names a profile id and the server owns what runs, but the args still come from
    // config, and `--` is what keeps a leading-dash argument from being read as a tmux option.
    const { tmux, calls } = fake({ "list-sessions": "" });
    return tmux.createOrAttach("s", "/w", "claude", ["--dangerous"], {}).then(() => {
      const create = calls.find((c) => c[0] === "new-session");
      const first = commandsOf(create ?? [])[0] ?? [];
      assert.deepEqual(first.slice(first.indexOf("--") + 1), ["claude", "--dangerous"]);
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
    assert.deepEqual(commandsOf(calls[0] ?? []), [
      ["start-server"],
      ["set-option", "-g", "exit-empty", "off"],
      ["set-option", "-g", "update-environment", ""],
    ]);
  });

  void test("empties update-environment, which is the client half of a built environment", async () => {
    // The default copies SSH_AUTH_SOCK, DISPLAY and friends out of whichever tmux CLIENT creates
    // or attaches to a session and into that session's environment - so a clean server global
    // environment on its own still hands a pane the forwarded ssh-agent the moment anything
    // attaches. Observed on tmux 3.7b: with the default, `show-environment -t` listed
    // SSH_AUTH_SOCK; emptied, it listed only what -e put there.
    const { tmux, calls } = fake();
    await tmux.ensureServer();
    assert.ok(
      commandsOf(calls[0] ?? []).some(
        (c) => c[0] === "set-option" && c[2] === "update-environment" && c[3] === "",
      ),
    );
  });
});

void describe("the environment a tmux server is started with", () => {
  void test("is built from named variables, not inherited from the launching shell", () => {
    // The tmux SERVER is a child of whichever invocation starts it, and every pane inherits the
    // server's global environment. Inheriting meant an agent session saw SSH_AUTH_SOCK - the
    // forwarded ssh-agent, and with it `git push --force` to every repository that key reaches -
    // and any other variable the shell that ran `pnpm start` happened to carry.
    const built = baseEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      AWS_SECRET_ACCESS_KEY: "sk-live",
      SEKRIT: "marker",
    });
    assert.deepEqual(Object.keys(built).sort(), ["HOME", "PATH", "TERM"]);
    assert.equal(built["SSH_AUTH_SOCK"], undefined);
    assert.equal(built["SEKRIT"], undefined);
  });

  void test("nothing on the list is a credential", () => {
    // The list is small enough to read, and this is what reading it is for: every name on it is
    // something a terminal needs to be a terminal. An API key reaches a session by being named
    // in that agent's profile `env`, where it is written down (plan 004).
    for (const name of BASE_ENV_NAMES) {
      assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL/i, name);
    }
  });

  void test("a process started with no TERM still gets a usable terminal", () => {
    // launchd, or any supervisor: a pane with no TERM renders as a dumb terminal, which is a
    // broken session rather than a contained one.
    assert.equal(baseEnv({ PATH: "/usr/bin" })["TERM"], "xterm-256color");
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

// -----------------------------------------------------------------------------------------
// Against a real tmux server
// -----------------------------------------------------------------------------------------

// The two findings this section closes were both verified by hand before they were fixed, and a
// fake tmux cannot re-verify either: what leaked was tmux's own behaviour - what a pane inherits
// from the server, and what `show-environment` will hand to any process running as this user. So
// this drives the real binary on a socket of its own, with a marker variable in the environment
// of the process that starts the server, exactly as the done-when sentence describes.
void describe("what a real tmux server hands a real pane", () => {
  const socket = `agentdeck-test-${String(process.pid)}`;
  const tmux = new Tmux({ socket });
  const out = join(tmpdir(), `agentdeck-pane-env-${String(process.pid)}`);

  after(() => {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // Already gone: the desired end state.
    }
    rmSync(out, { force: true });
  });

  void test("the pane has the secret, and show-environment does not", async () => {
    // The launching process carries both a marker variable and a fake SSH_AUTH_SOCK. Neither is
    // on BASE_ENV_NAMES and neither is in any profile, so neither may reach the pane - while
    // AGENTDECK_SECRET, which was passed explicitly, must.
    process.env["SEKRIT_MARKER"] = "the-launching-shell";
    process.env["SSH_AUTH_SOCK"] = "/tmp/agentdeck-test-agent.sock";
    try {
      await tmux.ensureServer();
      await tmux.createOrAttach("envprobe", tmpdir(), "/bin/sh", ["-c", `env > ${out}; sleep 5`], {
        AGENTDECK_SECRET: "s3cret-value",
        AGENTDECK_SESSION_ID: "envprobe",
      });

      // The pane forks when new-session runs; the file appears a moment later.
      let paneEnv = "";
      for (let attempt = 0; attempt < 50 && paneEnv === ""; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          paneEnv = readFileSync(out, "utf8");
        } catch {
          // Not written yet.
        }
      }
      assert.notEqual(paneEnv, "", "the pane never wrote its environment");

      assert.match(paneEnv, /^AGENTDECK_SECRET=s3cret-value$/m, "the agent did not get its secret");
      assert.doesNotMatch(paneEnv, /^SEKRIT_MARKER=/m, "the pane inherited the launching shell");
      assert.doesNotMatch(paneEnv, /^SSH_AUTH_SOCK=/m, "the pane got the forwarded ssh-agent");

      // And the reader's half: any process running as this user can run this command.
      const shown = execFileSync("tmux", ["-L", socket, "show-environment", "-t", "envprobe"], {
        encoding: "utf8",
      });
      assert.doesNotMatch(shown, /s3cret-value/, "show-environment printed the session secret");
      assert.doesNotMatch(shown, /SSH_AUTH_SOCK=/, "update-environment injected the ssh-agent");
    } finally {
      delete process.env["SEKRIT_MARKER"];
      delete process.env["SSH_AUTH_SOCK"];
    }
  });
});
