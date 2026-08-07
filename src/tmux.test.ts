import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { BASE_ENV_NAMES, baseEnv, isEmptyTmux, isMissingSession, Tmux } from "./tmux.ts";

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
    // m0/create-500. A client tmux does not believe is UTF-8 gets `_` in place of every byte tmux
    // considers non-printable, including the U+001F this format is built on. Reading such a line
    // leniently gave every session the whole line as its id, which `Registry.list()` then dropped
    // for having no metadata - a create that had worked, reported as a 500, agent still running.
    // Refusing is the point: half a list is worse than an error, because nothing downstream can
    // tell it from a machine with fewer sessions on it. The mangled line is the one the real tmux
    // returned on the reported run, byte for byte. The mangling rewrites EVERY U+001F, so the
    // signature is that no line at all carries a separator.
    const { tmux } = fake({
      "list-sessions": "a-claude-1_0__1700000000_/a\nrepo-sh-df464c46_0__1786113059_/x\n",
    });
    await assert.rejects(async () => await tmux.list(), /field separator[\s\S]*UTF-8/);
  });

  void test("a newline in one session's path costs that session, not the whole list", async () => {
    // `#{session_path}` is last in the format and a path may legally contain a newline, so a
    // session created in `/tmp/ro\ngue` splits into a parseable record plus a separator-less
    // remainder. Anything running as this user can create one; if that remainder failed `list()`
    // every 2s tick, one rogue session would take every other session's stream and every tab
    // with it, with no supervisor to restart the process. It must cost at most itself.
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
    // The refusal above must fire on the mangling and nothing else. Session names are attacker-
    // adjacent - anything running as this user can create one - but a name can only ADD
    // separators to the line, never remove them, so it cannot reach the refusal. It also cannot
    // impersonate one of ours: the id it parses to is not the id `Registry` has metadata for.
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
    // macOS will not show another process's environment to `ps`, and it shows every process's
    // ARGV to everything this user runs - verified on this Mac, `ps -Ao args=` printed a sibling's
    // full argv. With `-e NAME=VALUE`, an agent sampling `ps` in a loop caught the tmux client
    // created for the NEXT session and read the operator's API key out of it. So the values ride
    // the client's own environment and `update-environment` names which of them tmux copies in.
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
    // The copy reaches the pane by putting the variable in the SESSION environment, where tmux
    // keeps it: `tmux -L <socket> show-environment -t <session>` would otherwise print the
    // per-session hook secret, and every API key a profile passed through, to any process running
    // as this user. tmux builds the pane's environment when new-session forks it, so unsetting in
    // the same chained invocation takes the value from the reader and not from the agent.
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
    // node puts the whole argv into the rejection message of a failed execFile, and this argv
    // carries `-e AGENTDECK_SECRET=... -e ANTHROPIC_API_KEY=...`. That message reached the client
    // verbatim through the generic 500, so the phone rendered the operator's key. Any non-zero
    // exit does it: a socket tmux refuses to connect to, a fork failure, a chained set-option
    // that fails.
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
    // exit-empty defaults to ON, so a server holding no sessions terminates - which is every
    // server at boot. `start-server` reports success either way, so this is invisible until
    // something tries to use the server that is already gone.
    const { tmux, calls } = fake();
    await tmux.ensureServer();
    // One invocation, not two: as separate calls the empty server exits between them and
    // set-option fails with "no server running". Observed, not theorised. What matters is that
    // these three share a single invocation, which the deepEqual below is what actually proves -
    // this used to assert `calls.length === 1` as a proxy for it, which also forbade the
    // later `show-environment` sweep of a pre-existing server's globals. The race is between
    // start-server and set-option and nothing else, so the guarantee is unchanged.
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
    // LC_CTYPE is there because nothing on the input declared a UTF-8 locale - see `baseEnv`, and
    // src/create-500.test.ts for what a non-UTF-8 tmux client did to `list-sessions` output.
    assert.deepEqual(Object.keys(built).sort(), ["HOME", "LC_CTYPE", "PATH", "TERM"]);
    assert.equal(built["LC_CTYPE"], "UTF-8");
    assert.equal(baseEnv({ PATH: "/usr/bin", LANG: "ja_JP.UTF-8" })["LC_CTYPE"], undefined);
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

  void test("an LC_ALL that is not UTF-8 is passed through, and defaulting cannot rescue it", () => {
    // LC_ALL outranks LC_CTYPE in every implementation, so the LC_CTYPE default below is inert
    // here: this run WILL talk to tmux as a non-UTF-8 client and WILL get `_` where the field
    // separator should be. baseEnv does not silently overwrite a locale the operator set, which
    // is exactly why `Tmux.list()` refuses a separator-less line loudly - see
    // src/create-500.test.ts. This test records that the gap is known, not that it is fixed.
    const built = baseEnv({ PATH: "/usr/bin", LC_ALL: "C" });
    assert.equal(built["LC_ALL"], "C");
    assert.equal(built["LC_CTYPE"], "UTF-8");
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

  void test("a server we did not start does not hand its environment to our panes", async () => {
    // The case the first version of this branch documented as unreachable and left open: with a
    // live server already on the socket, `start-server` is a no-op, so building the CLIENT's
    // environment bounds nothing - the pane inherits the server's global environment instead.
    // The trigger is prescribed by our own refusal text and the README, both of which tell the
    // operator to `tmux -L agentdeck attach`, and attaching starts a server.
    //
    // Emptying `update-environment` makes this strictly worse, which is why it could not stay a
    // residual: tmux's default list NAMES SSH_AUTH_SOCK, so the default was overwriting it from
    // our clean client. Verified by hand on tmux 3.7b - with the list emptied and a dirty
    // pre-existing server, the pane saw both the marker and the forwarded agent.
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
    // The claim "built, not inherited" is about what a pane INHERITS. `HOME` has to be on the
    // list, so a login shell reads the dotfiles it points at and re-exports whatever they export -
    // and `export SSH_AUTH_SOCK=...` in `~/.zprofile` is what 1Password and `ssh-agent` both
    // document. This is why `agents.example.json` no longer passes `-l`, and why the README says
    // the residue out loud instead of claiming the variable cannot come back.
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
    // `-l` sources `/etc/zprofile`, `~/.zprofile`, `~/.zshrc` and `~/.zlogin`, and the setup
    // 1Password documents puts `SSH_AUTH_SOCK` in one of them - which hands the session the
    // forwarded ssh-agent the README says it does not have.
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
