import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  BASE_ENV_NAMES,
  baseEnv,
  isEmptyTmux,
  isMissingSession,
  Tmux,
  forTerminal,
} from "./tmux.ts";

const SEP = "\u001f";

/** A fake tmux that records what it was asked and replays canned stdout. */
const fake = (responses: Record<string, string | Error> = {}) => {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const tmux = new Tmux({
    socket: "test",
    exec: async (args, extra) => {
      calls.push(args);
      envs.push(extra);
      // By membership rather than by args[0]: one invocation chains several tmux commands, and
      // the one that names the response is not always the first of them.
      const key = Object.keys(responses).find((name) => args.includes(name)) ?? "";
      const response = responses[key];
      if (response instanceof Error) throw response;
      return await Promise.resolve({ stdout: response ?? "", stderr: "" });
    },
  });
  return { tmux, calls, envs };
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

  void test("mangled output fails the whole list rather than being read as sessions", async () => {
    // A non-UTF-8 client gets `_` for every U+001F, so reading leniently gave every session the
    // whole line as its id. Half a list is worse than an error: nothing downstream can tell them apart.
    const { tmux } = fake({
      "list-sessions": "a-claude-1_0__1700000000_/a\nrepo-sh-df464c46_0__1786113059_/x\n",
    });
    await assert.rejects(async () => await tmux.list(), /field separator[\s\S]*UTF-8/);
  });

  void test("a newline in one session's path costs that session, not the whole list", async () => {
    // A path may contain a newline, so one session splits into a record plus a separator-less
    // remainder. Anything running as this user can make one, so it must cost at most itself.
    const { tmux } = fake({
      "list-sessions": `${line("a-claude-1", "0", "")}${SEP}/tmp/ro\ngue\n${line("b-claude-2", "0", "")}${SEP}/tmp/ok\n`,
    });
    const sessions = await tmux.list();
    assert.deepEqual(
      sessions.map((s) => s.id),
      ["a-claude-1", "b-claude-2"],
    );
  });

  void test("a session name containing the separator is still parsed, not called mangled", async () => {
    // The refusal must fire on the mangling and nothing else: a crafted name can only ADD
    // separators, never remove them, and the id it parses to is not one the registry knows.
    const { tmux } = fake({ "list-sessions": `${line(`odd${SEP}name`, "0", "")}\n` });
    const [session] = await tmux.list();
    assert.equal(session?.id, "odd");
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
      // `=name:` and not `name`: a window target that resolves by prefix or fnmatch would set the
      // option on whatever session happens to share the prefix.
      "=web-claude-abc:",
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
    // One session's secret must never become another's, so it is given to the client that creates
    // that one session and to nothing else.
    const { tmux, calls, envs } = fake({ "list-sessions": "" });
    await tmux.createOrAttach("s", "/w", "claude", [], { AGENTDECK_SECRET: "abc" });
    const index = calls.findIndex((c) => c.includes("new-session"));
    assert.equal(envs[index]?.["AGENTDECK_SECRET"], "abc");
    for (const [i, extra] of envs.entries()) {
      if (i !== index) assert.equal(extra?.["AGENTDECK_SECRET"], undefined);
    }
  });

  void test("no value is ever an argument, because argv is public", async () => {
    // macOS hides another process's environment from `ps` and shows its ARGV, so `-e NAME=VALUE`
    // hands an agent sampling `ps` the next session's key. The values ride the client's environment.
    const { tmux, calls, envs } = fake({ "list-sessions": "" });
    await tmux.createOrAttach("s", "/w", "claude", [], {
      AGENTDECK_SECRET: "s3cretvalue",
      ANTHROPIC_API_KEY: "sk-ant-live",
    });
    for (const call of calls) {
      for (const arg of call) {
        assert.doesNotMatch(arg, /s3cretvalue|sk-ant-live/, `a value reached argv: ${arg}`);
      }
    }

    const create = calls.find((c) => c.includes("new-session"));
    assert.ok(create, "no new-session call");
    const commands = commandsOf(create);
    // The name list is set before the session is created - the copy happens as tmux creates it -
    // and emptied after, in the same invocation, so it cannot catch the next client's variables.
    const first = commands[0] ?? [];
    assert.deepEqual(first.slice(0, 3), ["set-option", "-g", "update-environment"]);
    assert.deepEqual((first[3] ?? "").split(" ").sort(), ["AGENTDECK_SECRET", "ANTHROPIC_API_KEY"]);
    assert.ok(
      commands
        .slice(1)
        .some((c) => c[0] === "set-option" && c[2] === "update-environment" && c[3] === ""),
      "update-environment is left naming the secrets",
    );
    const index = calls.indexOf(create);
    assert.equal(envs[index]?.["ANTHROPIC_API_KEY"], "sk-ant-live");
  });

  void test("and takes every one of them back out of the session environment", async () => {
    // The copy lands in the SESSION environment, which `show-environment -t` prints to anything
    // running as this user - and the pane is forked before it, so the unset takes it from readers only.
    const { tmux, calls } = fake({ "list-sessions": "" });
    await tmux.createOrAttach("s", "/w", "claude", [], {
      AGENTDECK_SECRET: "abc",
      ANTHROPIC_API_KEY: "sk-live",
      AGENTDECK_SESSION_ID: "s",
    });
    const create = calls.find((c) => c.includes("new-session"));
    assert.ok(create, "no new-session call");

    // One invocation, not a follow-up call: a second call is a window in which the secret is
    // readable, and a crash between the two would leave it there for the session's life.
    assert.equal(
      calls.filter((c) => c.includes("new-session") || c.includes("set-environment")).length,
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
      assert.deepEqual(command.slice(0, 4), ["set-environment", "-t", "=s", "-u"]);
      assert.equal(command.length, 5);
    }
  });

  void test("a failed create does not put the secret or an API key in the error", async () => {
    // node puts the whole argv into a failed execFile's message, and that message reached the
    // client verbatim through the generic 500. Any non-zero exit does it.
    const { tmux } = fake({
      "list-sessions": "",
      "new-session": Object.assign(
        new Error(
          "Command failed: tmux -L agdz new-session -d -A -s x -c /tmp " +
            "-e AGENTDECK_SECRET=s3cret -e ANTHROPIC_API_KEY=sk-live-xyz -- /bin/sh",
        ),
        { stderr: "error connecting to /tmp/tmux-501/agdz" },
      ),
    });
    await assert.rejects(
      async () =>
        await tmux.createOrAttach("x", "/tmp", "/bin/sh", [], {
          AGENTDECK_SECRET: "s3cret",
          ANTHROPIC_API_KEY: "sk-live-xyz",
        }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /s3cret/);
        assert.doesNotMatch(error.message, /sk-live-xyz/);
        // Still says what went wrong - a redaction that also removes the diagnosis is a different
        // failure, not a fix.
        assert.match(error.message, /error connecting to/);
        return true;
      },
    );
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
    // exit-empty defaults ON, so a server holding no sessions terminates - which is every server at
    // boot. `start-server` reports success either way, so it is invisible until something uses it.
    const { tmux, calls } = fake();
    await tmux.ensureServer();
    // One invocation, not two: as separate calls the empty server exits between them. The deepEqual
    // below proves that directly - `calls.length === 1` was a proxy that also forbade the sweep.
    assert.deepEqual(commandsOf(calls[0] ?? []), [
      ["start-server"],
      ["set-option", "-g", "exit-empty", "off"],
      ["set-option", "-g", "update-environment", ""],
      // The prefix is a command channel and every byte the phone sends reaches it - see
      // `ensureServer`. Chained with the rest for the same reason they are: one invocation.
      ["set-option", "-g", "prefix", "none"],
      ["set-option", "-g", "prefix2", "none"],
      // tmux.conf reaches a server this call STARTS, and these three must hold on one someone else
      // started too - the ordinary case, since attaching by hand starts one.
      ["set-option", "-g", "status", "off"],
      ["set-option", "-g", "mouse", "off"],
      ["set-option", "-g", "history-limit", "10000"],
    ]);
  });

  void test("empties update-environment, which is the client half of a built environment", async () => {
    // The default copies SSH_AUTH_SOCK out of whichever CLIENT attaches and into the session, so a
    // clean server environment alone still hands a pane the forwarded agent.
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
    // The tmux SERVER is a child of whichever invocation starts it and every pane inherits its
    // global environment - which meant an agent session saw the forwarded ssh-agent.
    const built = baseEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      AWS_SECRET_ACCESS_KEY: "sk-live",
      SEKRIT: "marker",
    });
    // LC_CTYPE is there because nothing on the input declared a UTF-8 locale - see `baseEnv`, and
    // src/create-500.test.ts for what a non-UTF-8 tmux client did to `list-sessions` output.
    assert.deepEqual(Object.keys(built).sort(), ["HOME", "LC_CTYPE", "PATH", "TERM"]);
    assert.equal(built["LC_CTYPE"], "UTF-8");
    assert.equal(baseEnv({ PATH: "/usr/bin", LANG: "ja_JP.UTF-8" })["LC_CTYPE"], undefined);
    assert.equal(built["SSH_AUTH_SOCK"], undefined);
    assert.equal(built["SEKRIT"], undefined);
  });

  void test("nothing on the list is a credential", () => {
    // Every name on the list is something a terminal needs to be a terminal. An API key reaches a
    // session by being named in that agent's profile `env`, where it is written down.
    for (const name of BASE_ENV_NAMES) {
      assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL/i, name);
    }
  });

  void test("an operator's own UTF-8 locale is kept, in whichever variable declares it", () => {
    // Defaulted, not forced. Overwriting LC_CTYPE on a machine whose operator has chosen a locale
    // would change how their agents render text, to fix a problem they do not have.
    for (const name of ["LC_ALL", "LC_CTYPE", "LANG"]) {
      const built = baseEnv({ PATH: "/usr/bin", [name]: "ja_JP.UTF-8" });
      assert.equal(built[name], "ja_JP.UTF-8", name);
      assert.equal(built["LC_CTYPE"], name === "LC_CTYPE" ? "ja_JP.UTF-8" : undefined, name);
    }
    assert.equal(baseEnv({ PATH: "/usr/bin", LANG: "en_US.utf8" })["LC_CTYPE"], undefined);
  });

  void test("a non-UTF-8 locale is fixed in the variable that actually wins", () => {
    // POSIX precedence, not "any of the three mentions UTF-8": both environments below used to
    // yield a non-UTF-8 client, and so a `list()` that throws for every session on the socket.
    const allC = baseEnv({ PATH: "/usr/bin", LC_ALL: "C" });
    assert.equal(allC["LC_ALL"], undefined);
    assert.equal(allC["LC_CTYPE"], "UTF-8");

    // (b) LANG says UTF-8 but LC_CTYPE says C: LC_CTYPE wins, so a match on LANG proves nothing.
    const ctypeC = baseEnv({ PATH: "/usr/bin", LANG: "en_US.UTF-8", LC_CTYPE: "C" });
    assert.equal(ctypeC["LC_CTYPE"], "UTF-8");
    assert.equal(ctypeC["LC_ALL"], undefined);

    // And the mirror image: an LC_ALL that IS UTF-8 outranks a non-UTF-8 LC_CTYPE, so nothing is
    // touched.
    const allUtf8 = baseEnv({ PATH: "/usr/bin", LC_ALL: "C.UTF-8", LC_CTYPE: "C" });
    assert.equal(allUtf8["LC_ALL"], "C.UTF-8");
    assert.equal(allUtf8["LC_CTYPE"], "C");
  });

  void test("LC_CTYPE is on the name list, so the global-environment sweep does not strip it", () => {
    // ensureServer unsets every global variable that is NOT on this list. Off the list, the
    // locale a tmux client needs would be swept away by the next boot that found it.
    assert.ok(BASE_ENV_NAMES.includes("LC_CTYPE"));
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
    // CR LF out, LF in: capture-pane separates lines the way a file does and the terminal it is
    // written into is not in convertEol mode. See `forTerminal`.
    assert.equal(out, "old output\r\n");
    const call = calls[0];
    assert.ok(call, "capture-pane was never called");
    assert.ok(call.includes("-e"));
    assert.ok(call.includes("-p"));
    // NOT -J: pane and client are both fixed, so there is nothing to re-wrap, and -J welds a
    // full-width line to the next one.
    assert.ok(!call.includes("-J"), "-J joins lines the pane never joined");
    assert.deepEqual(call.slice(call.indexOf("-S"), call.indexOf("-S") + 2), ["-S", "-2000"]);
  });

  void test("capturing a session that has gone returns nothing rather than throwing", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "can't find session: s" });
    const { tmux } = fake({ "capture-pane": error });
    assert.equal(await tmux.captureHistory("s", 100), "");
  });

  void test("repaint targets the client tty, because refresh-client takes nothing else", async () => {
    // `refresh-client -t` is a CLIENT target, so a session name is a different namespace entirely -
    // tmux answers "can't find client" and the snapshot's repaint never happens.
    const { tmux, calls } = fake({ "list-clients": "/dev/ttys010\n", "refresh-client": "" });
    await tmux.repaint("s");
    assert.deepEqual(calls[0]?.slice(-4), ["-t", "=s", "-F", "#{client_tty}"]);
    assert.deepEqual(calls[1]?.slice(-3), ["-t", "/dev/ttys010", "-R"]);
  });

  void test("every attached client is refreshed, not the concatenated list as one target", async () => {
    // Anyone can attach a second client, and then `list-clients` prints two lines - one
    // `refresh-client -t` over both exits 1, so no snapshot is sent while that client stays.
    const { tmux, calls } = fake({
      "list-clients": "/dev/ttys010\n/dev/ttys012\n",
      "refresh-client": "",
    });
    await tmux.repaint("s");
    assert.deepEqual(calls[1]?.slice(-3), ["-t", "/dev/ttys010", "-R"]);
    assert.deepEqual(calls[2]?.slice(-3), ["-t", "/dev/ttys012", "-R"]);
  });

  void test("a session with no attached client cannot repaint, and says so", async () => {
    const { tmux } = fake({ "list-clients": "" });
    await assert.rejects(
      async () => await tmux.repaint("s"),
      /no tmux client is attached to s/,
      "an unlabelled failure here reads to the client as an empty screen",
    );
  });
});

void describe("alternate screen", () => {
  void test("reports the pane's mode from #{alternate_on}", async () => {
    // Verified by hand on tmux 3.7b: `0` at a shell prompt, `1` after the pane writes
    // `\\033[?1049h`, and clean ASCII either way to a client with no locale set at all.
    const on = fake({ "display-message": "1\n" });
    assert.equal(await on.tmux.isAlternateScreen("s"), true);
    assert.ok(on.calls[0]?.includes("#{alternate_on}"));

    const off = fake({ "display-message": "0\n" });
    assert.equal(await off.tmux.isAlternateScreen("s"), false);
  });

  void test("a session that has gone is not on the alternate screen", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "can't find session: s" });
    const { tmux } = fake({ "display-message": error });
    assert.equal(await tmux.isAlternateScreen("s"), false);
  });
});

void describe("the pane's modes", () => {
  void test("reads the five flags in one call", async () => {
    // Verified by hand against a live Claude Code 2.1 pane on the deck's socket: `10011`, which is
    // the alternate screen with all-motion tracking in SGR.
    const { tmux, calls } = fake({ "display-message": "10011\n" });
    assert.deepEqual(await tmux.paneModes("s"), { alternate: true, tracking: 1003, sgr: true });
    assert.ok(calls[0]?.some((arg) => arg.includes("#{mouse_all_flag}")));
  });

  void test("a session that has gone has no modes to state", async () => {
    const error = Object.assign(new Error("exited"), { stderr: "can't find session: s" });
    const { tmux } = fake({ "display-message": error });
    assert.deepEqual(await tmux.paneModes("s"), { alternate: false, tracking: 0, sgr: false });
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

  // `exit-empty off` leaves the server up with no sessions, and `list-panes -a` calls that
  // "no current target". Read as a failure it made GET /api/processes a 500 whenever the deck
  // had no session open, which is the state it boots in.
  void test("an empty pane list is not an error", async () => {
    assert.equal(isEmptyTmux({ stderr: "no current target" }), true);
    assert.equal(isMissingSession({ stderr: "no current target" }), false);
    const { tmux } = fake({ "list-panes": new Error("no current target") });
    assert.deepEqual(await tmux.panePids(), []);
  });
});

// --- Against a real tmux server ---

// A fake tmux cannot verify either finding here: what leaked was tmux's own behaviour. This drives
// the real binary on its own socket, with a marker variable in the starting process's environment.
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
    // The launching process carries a marker and a fake SSH_AUTH_SOCK, neither on BASE_ENV_NAMES
    // nor in a profile, so neither may reach the pane - while the explicit secret must.
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

  void test("the client carrying the secrets never starts the tmux server", async () => {
    // Whichever client starts the server donates its whole environment to the GLOBAL one, which the
    // per-session unsets do not touch - and a create can be the call that starts it.
    const fresh = `${socket}-nosrv`;
    const freshTmux = new Tmux({ socket: fresh });
    try {
      await freshTmux.createOrAttach("secretprobe", tmpdir(), "/bin/sh", ["-c", "sleep 5"], {
        AGENTDECK_SECRET: "leak-canary-value",
        AGENTDECK_SESSION_ID: "secretprobe",
      });
      const globals = execFileSync("tmux", ["-L", fresh, "show-environment", "-g"], {
        encoding: "utf8",
      });
      assert.doesNotMatch(
        globals,
        /leak-canary-value/,
        "the secret reached the tmux server's global environment, where every pane inherits it",
      );
    } finally {
      try {
        execFileSync("tmux", ["-L", fresh, "kill-server"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
    }
  });

  void test("the prefix is not a command channel on our socket", async () => {
    // Everything typed reaches a tmux CLIENT's stdin and is parsed as KEYS first, so the default
    // C-b makes `run-shell` host execution. The unit test proves we sent it; this proves tmux took it.
    const guarded = `${socket}-prefix`;
    const guardedTmux = new Tmux({ socket: guarded });
    try {
      await guardedTmux.ensureServer();
      const shown = execFileSync("tmux", ["-L", guarded, "show-options", "-g", "prefix"], {
        encoding: "utf8",
      });
      const second = execFileSync("tmux", ["-L", guarded, "show-options", "-g", "prefix2"], {
        encoding: "utf8",
      });
      assert.match(shown, /none/i, "the tmux prefix is still bound, so the phone can reach it");
      assert.match(second, /none/i, "the secondary prefix is still bound");
    } finally {
      try {
        execFileSync("tmux", ["-L", guarded, "kill-server"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
    }
  });

  void test("a server we did not start does not hand its environment to our panes", async () => {
    // With a live server already on the socket `start-server` is a no-op, so the CLIENT environment
    // bounds nothing - and emptying `update-environment` makes it worse, not better.
    const dirty = `${socket}-dirty`;
    const dirtyOut = join(tmpdir(), `agentdeck-dirty-env-${String(process.pid)}`);
    const dirtyTmux = new Tmux({ socket: dirty });
    try {
      // A server started by someone else, from a shell holding things no profile allowlisted.
      execFileSync("tmux", ["-L", dirty, "new-session", "-d", "-s", "operator", "sleep", "30"], {
        env: {
          ...process.env,
          SEKRIT_MARKER: "the-operators-shell",
          SSH_AUTH_SOCK: "/tmp/agentdeck-test-agent.sock",
        },
      });

      await dirtyTmux.ensureServer();
      await dirtyTmux.createOrAttach(
        "dirtyprobe",
        tmpdir(),
        "/bin/sh",
        ["-c", `env > ${dirtyOut}; sleep 5`],
        { AGENTDECK_SESSION_ID: "dirtyprobe" },
      );

      let paneEnv = "";
      for (let attempt = 0; attempt < 50 && paneEnv === ""; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          paneEnv = readFileSync(dirtyOut, "utf8");
        } catch {
          // Not written yet.
        }
      }
      assert.notEqual(paneEnv, "", "the pane never wrote its environment");

      assert.doesNotMatch(
        paneEnv,
        /^SEKRIT_MARKER=/m,
        "the pane inherited the shell that started the pre-existing server",
      );
      assert.doesNotMatch(
        paneEnv,
        /^SSH_AUTH_SOCK=/m,
        "the pane got the ssh-agent forwarded into a server we did not start",
      );
    } finally {
      try {
        execFileSync("tmux", ["-L", dirty, "kill-server"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
      rmSync(dirtyOut, { force: true });
    }
  });

  void test("a login shell in the pane puts the operator's dotfiles back", async () => {
    // "Built, not inherited" is about what a pane INHERITS: `HOME` must be on the list, so a login
    // shell re-exports whatever the dotfiles export - which is the documented 1Password setup.
    const home = mkdtempSync(join(tmpdir(), `agentdeck-home-${String(process.pid)}-`));
    const login = `${out}-login`;
    const plain = `${out}-plain`;
    const wait = async (file: string) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          const text = readFileSync(file, "utf8");
          if (text !== "") return text;
        } catch {
          // Not written yet.
        }
      }
      return "";
    };
    try {
      writeFileSync(join(home, ".zprofile"), "export SSH_AUTH_SOCK=/tmp/from-dotfile.sock\n");
      await tmux.ensureServer();

      // HOME and ZDOTDIR ride the same per-session channel a profile's `env` does, so this reads
      // the temporary dotfile and never the operator's own.
      const dotfiles = { HOME: home, ZDOTDIR: home };
      await tmux.createOrAttach(
        "loginprobe",
        tmpdir(),
        "/bin/zsh",
        ["-l", "-c", `env > ${login}; sleep 5`],
        dotfiles,
      );
      assert.match(
        await wait(login),
        /^SSH_AUTH_SOCK=\/tmp\/from-dotfile\.sock$/m,
        "a login shell was expected to source the dotfiles - if it no longer does, the README and " +
          "plan 005 are now understating what a session gets, not overstating it",
      );

      // And the shape the example ships: same shell, same dotfiles, no `-l`.
      await tmux.createOrAttach(
        "plainprobe",
        tmpdir(),
        "/bin/zsh",
        ["-c", `env > ${plain}; sleep 5`],
        dotfiles,
      );
      assert.doesNotMatch(await wait(plain), /^SSH_AUTH_SOCK=/m);
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(login, { force: true });
      rmSync(plain, { force: true });
    }
  });
});

void describe("what a session's shell puts back, which the name list does not bound", () => {
  const repoRoot = new URL("../", import.meta.url);
  const readDoc = async (name: string) => await readFile(new URL(name, repoRoot), "utf8");

  void test("the shipped shell profile does not start a login shell", async () => {
    // `-l` sources the zsh profile files, and the setup 1Password documents puts `SSH_AUTH_SOCK`
    // in one of them - handing the session the forwarded agent SECURITY.md says it does not have.
    const example = JSON.parse(await readDoc("agents.example.json")) as Record<
      string,
      { args?: string[] }
    >;
    for (const [id, profile] of Object.entries(example)) {
      for (const arg of profile.args ?? []) {
        assert.notEqual(arg, "-l", `profile ${id} starts a login shell`);
        assert.notEqual(arg, "--login", `profile ${id} starts a login shell`);
      }
    }
  });

  void test("the README says the bound is on inheritance, not on what an rc file re-exports", async () => {
    // The sentence that was wrong: "Nothing else from the shell that ran `pnpm start` reaches it"
    // read as "SSH_AUTH_SOCK cannot reach a session", which the operator's own dotfiles disprove.
    const readme = await readDoc("README.md");
    assert.match(readme, /dotfiles/i, "the README does not mention dotfiles at all");
    const paragraph = readme.slice(readme.indexOf("built, not inherited"));
    assert.match(
      paragraph.slice(0, 1200),
      /dotfiles `HOME` points at/,
      "the README does not say that a credential in the dotfiles reaches the session anyway",
    );
  });
});

void describe("captured scrollback is turned into bytes a terminal can be written with", () => {
  // The shapes here are what tmux 3.7b actually returned from a 40-column pane, not invented ones:
  // LF-separated lines with no CR anywhere, and a coloured line that keeps its opening SGR.
  void test("a line padded to the pane width comes back its own length", () => {
    assert.equal(
      forTerminal(`PADDED-A${" ".repeat(32)}\nPADDED-B${" ".repeat(32)}`),
      "PADDED-A\r\nPADDED-B",
    );
  });

  void test("what a client wraps is decided by the text, not by the padding", () => {
    // What the phone showed: a padded line is exactly a row, so the next starts in the middle of
    // it - breaks mid-line in scrollback while the live stream was fine.
    const captured = forTerminal(`> ask${" ".repeat(35)}\nanswer${" ".repeat(34)}`);
    for (const line of captured.split("\r\n")) {
      assert.ok(line.length <= 40, `"${line}" is still padded out to the pane width`);
    }
  });

  void test("lines are separated the way a PTY separates them", () => {
    // capture-pane gives LF alone and the terminal is not in convertEol mode, so without this the
    // scrollback renders as a staircase - each line indented by the length of the one above.
    assert.equal(forTerminal("one\ntwo\nthree"), "one\r\ntwo\r\nthree");
  });

  void test("a capture that already ends its lines with CR LF is not given a second CR", () => {
    assert.equal(forTerminal("one\r\ntwo"), "one\r\ntwo");
  });

  void test("a colour that is closed at the end of the line stays closed", () => {
    // Stripping the spaces must not take the reset with them, or the colour bleeds into whatever
    // the client draws next.
    assert.equal(forTerminal("\u001b[32mgreen   \u001b[0m"), "\u001b[32mgreen\u001b[0m");
  });

  void test("spaces inside a line are text and are left alone", () => {
    assert.equal(forTerminal("a   b   c"), "a   b   c");
    assert.equal(forTerminal("  indented"), "  indented");
  });

  void test("a blank line stays a blank line rather than becoming nothing to join", () => {
    assert.equal(forTerminal("one\n    \ntwo"), "one\r\n\r\ntwo");
  });
});

// Closing a session ends what it was RUNNING, not just the pane: of three pythons started in one,
// the `nohup` one was still there days after the pane was killed.
void describe("closing a session takes its processes with it", () => {
  const socket = `agentdeck-close-${String(process.pid)}`;
  const tmux = new Tmux({ socket });
  const strays: number[] = [];

  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const state = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
    return !(state.stdout || "").trim().startsWith("Z");
  };

  after(() => {
    for (const pid of strays) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already reaped, which is what this suite is about.
      }
    }
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // Already gone: the desired end state.
    }
  });

  void test("a detached grandchild is killed, where kill-session alone left it running", async () => {
    await tmux.ensureServer();
    // `nohup` and a redirect: the shape that SURVIVES kill-session. Without them the process dies
    // of the SIGHUP anyway and the case would pass against code that does nothing.
    await tmux.createOrAttach(
      "leftover",
      tmpdir(),
      "/bin/sh",
      ["-c", "nohup /bin/sleep 100000 >/dev/null 2>&1 & exec /bin/sleep 200000"],
      { AGENTDECK_SESSION_ID: "leftover" },
    );
    let pane = 0;
    let child = 0;
    for (let i = 0; i < 100 && child === 0; i += 1) {
      const found = (await tmux.panePids()).find((entry) => entry.sessionId === "leftover");
      pane = found?.panePid ?? 0;
      if (pane > 0) {
        const kid = spawnSync("/usr/bin/pgrep", ["-P", String(pane)], { encoding: "utf8" });
        child = Number(kid.stdout.trim().split("\n")[0] ?? 0);
      }
      if (child === 0) spawnSync("/bin/sleep", ["0.05"]);
    }
    assert.ok(pane > 1 && child > 1, "the fixture never produced a pane with a child");
    strays.push(pane, child);

    await tmux.kill("leftover");

    for (let i = 0; i < 100 && (running(pane) || running(child)); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(!running(pane), `the pane process ${String(pane)} survived the close`);
    assert.ok(!running(child), `the detached child ${String(child)} survived the close`);
  });

  void test("a session whose name is a PREFIX of another is not touched", async () => {
    // `=` is exact for kill-session but NOT for list-panes, and that list feeds a kill - so
    // resolving by prefix would end a different agent's processes.
    await tmux.ensureServer();
    await tmux.createOrAttach("alpha", tmpdir(), "/bin/sleep", ["100000"], {
      AGENTDECK_SESSION_ID: "alpha",
    });
    await tmux.createOrAttach("alphabet", tmpdir(), "/bin/sleep", ["100000"], {
      AGENTDECK_SESSION_ID: "alphabet",
    });
    const paneOf = async (id: string): Promise<number> =>
      (await tmux.panePids()).find((entry) => entry.sessionId === id)?.panePid ?? 0;
    const survivor = await paneOf("alphabet");
    assert.ok(survivor > 1, "the session that must survive never started");
    strays.push(survivor);

    await tmux.kill("alpha");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(running(survivor), `closing "alpha" killed "alphabet"'s pane ${String(survivor)}`);
  });
});

void describe("the field separator, in either rendering tmux gives it", () => {
  // tmux 3.5a escapes a non-printable byte in `-F` output as `\\037`; the 3.7b plan 002 verified
  // against emits the byte. These run off canned stdout on purpose: an integration test only ever
  // sees the rendering of the tmux this host happens to have, and so proves nothing about the other.
  const renderings: [string, string][] = [
    ["the raw byte", SEP],
    ["the octal escape", "\\037"],
  ];

  for (const [label, sep] of renderings) {
    void test(`list() reads a session written with ${label}`, async () => {
      const { tmux } = fake({
        "list-sessions": ["agentdeck-shell-abc", "0", "", "1700000000", "/repo/a"].join(sep),
      });
      const [session] = await tmux.list();
      assert.equal(session?.id, "agentdeck-shell-abc");
      assert.equal(session?.path, "/repo/a");
      assert.equal(session?.dead, false);
      assert.equal(session?.startedAt, 1_700_000_000_000);
    });

    void test(`panePids() reads a pane written with ${label}`, async () => {
      const { tmux } = fake({ "list-panes": ["agentdeck-shell-abc", "4242"].join(sep) });
      assert.deepEqual(await tmux.panePids(), [
        { sessionId: "agentdeck-shell-abc", panePid: 4242 },
      ]);
    });

    void test(`describe() reads a pane written with ${label}`, async () => {
      const { tmux } = fake({ "display-message": ["/repo/a", "1700000000"].join(sep) });
      assert.deepEqual(await tmux.describe("agentdeck-shell-abc"), {
        path: "/repo/a",
        startedAt: 1_700_000_000_000,
      });
    });

    void test(`a dead session keeps its exit code with ${label}`, async () => {
      const { tmux } = fake({
        "list-sessions": ["agentdeck-shell-abc", "1", "7", "1700000000", "/repo/a"].join(sep),
      });
      const [session] = await tmux.list();
      assert.equal(session?.dead, true);
      assert.equal(session?.exitCode, 7);
    });
  }

  void test("a path shaped like the escape costs that path alone, never the fields before it", () => {
    // tmux does not escape a backslash, so `\037` inside a path is indistinguishable from the
    // separator. The path is last, so its tail rejoins and the id and the clock stay right.
    const line = ["agentdeck-shell-abc", "0", "", "1700000000", "/repo/lit\\037eral"].join("\\037");
    const { tmux } = fake({ "list-sessions": line });
    return tmux.list().then((sessions) => {
      const session = sessions[0];
      assert.equal(session?.id, "agentdeck-shell-abc");
      assert.equal(session?.dead, false);
      assert.equal(session?.startedAt, 1_700_000_000_000);
      assert.notEqual(session?.path, "", "the path was dropped rather than kept");
    });
  });
});
