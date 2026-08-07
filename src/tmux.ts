import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// The tmux side of the session registry.
//
// Every session is `tmux new-session -A -s <name> <command>`. `-A` means attach-if-exists, so the
// same call starts a session or reattaches to a running one - which is what lets a restarted
// server reconnect to living agents instead of orphaning them, and what makes a laptop lid a
// non-event (plan 001).
//
// Two options are set at creation and both are load-bearing:
//
//   remain-on-exit on   tmux destroys a session the moment its command exits by default, so an
//                       agent that finished or crashed would remove its own tab and its exit code
//                       with it - leaving the strip unable to tell "it is done" from "I lost it",
//                       which is the distinction the strip exists for.
//   exit-empty off      the SERVER exits when it holds no sessions, which is on by default. That
//                       makes `start-server` succeed and the server vanish before anything can
//                       use it. Verified the expensive way: the health check reported "no server
//                       running" moments after the entrypoint logged that it was up.

export type SessionState = "working" | "waiting" | "idle" | "exited";

/**
 * The variable NAMES a tmux server we start is allowed to carry, and therefore the ones a pane
 * can inherit without a profile asking for them.
 *
 * This list is the whole of the environment, not an addition to the shell's. `tmux start-server`
 * is a child of the node process, so without this the server's global environment is whatever
 * shell ran `pnpm start` - and every pane forked from that server gets it. Verified by hand: a
 * pane saw both `SSH_AUTH_SOCK` and an arbitrary marker variable that no profile allowlisted,
 * which made plan 004's `env` name allowlist decorative and handed every agent the forwarded
 * ssh-agent.
 *
 * Each name earns its place: PATH so the agent binary resolves at all, HOME because every tool
 * reads config from it, SHELL/TERM/LANG/LC_ALL/TMPDIR/USER/LOGNAME because a terminal that lacks
 * them is a broken terminal rather than a contained one. Nothing here is a credential. Anything
 * an agent genuinely needs - an API key - is named in its profile's `env` and passes through
 * there, where it is written down.
 */
export const BASE_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "USER",
  "LOGNAME",
];

/**
 * The environment every tmux invocation - and so the tmux server we start - is given.
 *
 * `TERM` has a fallback because the node process is often started from something that has none
 * (launchd, a supervisor), and a pane with no TERM renders as a dumb terminal.
 */
export const baseEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out["TERM"] ??= "xterm-256color";
  return out;
};

export interface TmuxSession {
  id: string;
  dead: boolean;
  exitCode: number | undefined;
  startedAt: number;
  /** Where tmux says the session is, not where we remember pointing it. See `Registry.list`. */
  path: string;
}

/**
 * An EXACT tmux target.
 *
 * `-t name` is not an exact match: tmux resolves a target by exact name, then by prefix, then as
 * an fnmatch pattern. Verified on tmux 3.7b: with sessions `notesalpha` and `other` on one socket,
 * `kill-session -t notes` killed `notesalpha` and `kill-session -t 'oth*'` killed `other`, both
 * exit 0, while `-t '=alp'` failed with "can't find session". Every target this class sends is a
 * session id that arrived from a client, so a stale or mistyped one must miss rather than hit
 * whatever happens to share a prefix.
 */
export const exactTarget = (id: string): string => `=${id}`;

/**
 * The same thing for a command whose `-t` is a WINDOW or PANE target rather than a session one.
 *
 * `=name` alone is not a window target - verified on tmux 3.7b, `set-option -t =alpha` answers
 * "no such window" and `capture-pane -t =alpha` answers "can't find pane". The trailing colon is
 * what makes it "this session, its current window", exactly: `=alpha:` works and `=alp:` fails.
 */
export const exactWindowTarget = (id: string): string => `=${id}:`;

// A field separator that cannot appear in the values being formatted. tmux format strings are
// substituted before we see them, so a separator a session name could contain would let a
// crafted name forge extra fields.
const SEP = "\u001f";

export interface TmuxOptions {
  socket: string;
  /**
   * Injected so tests can drive the parser without a tmux server.
   *
   * `extra` is the second argument because the values a session needs travel in the CLIENT's
   * environment rather than in its argv - see `createOrAttach`.
   */
  exec?: (
    args: string[],
    extra?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export class Tmux {
  readonly socket: string;
  #exec: (
    args: string[],
    extra?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: TmuxOptions) {
    this.socket = options.socket;
    this.#exec =
      options.exec ??
      (async (args, extra) =>
        // `env` rather than the inherited one, and this is the load-bearing half of it: the tmux
        // SERVER is a child of whichever of these calls starts it, so its global environment -
        // which every pane inherits - is this object. `extra` is what a single session is given
        // on top of it, and it is here rather than on the command line because argv is public.
        await run("tmux", ["-L", this.socket, ...args], {
          encoding: "utf8",
          env: { ...baseEnv(), ...extra },
        }));
  }

  async #tmux(args: string[], extra?: Record<string, string>): Promise<string> {
    const { stdout } = await this.#exec(args, extra);
    return stdout;
  }

  /**
   * Create or reattach. Returns whether the session already existed, because the caller needs to
   * tell "started a new agent" from "handed back the one already running" to set `warning`.
   */
  async createOrAttach(
    id: string,
    cwd: string,
    command: string,
    args: readonly string[],
    env: Record<string, string>,
  ): Promise<{ attached: boolean }> {
    const existed = await this.has(id);
    if (!existed) {
      // -d so creating a session does not attach this process to it. The VALUES never appear in
      // an argument, and that is the point of the shape below.
      //
      // `-e NAME=VALUE` was the obvious way, and it lost the values twice over. Once because `-e`
      // puts the variable in the SESSION environment, where tmux keeps it, so any same-uid process
      // could read the per-session hook secret and every profile-passed API key with
      // `tmux -L <socket> show-environment -t <session>`. And once because a command line is
      // public: macOS will not show another process's ENVIRONMENT to `ps`, but it shows every
      // process's ARGV to every process this user runs - verified on this Mac, `ps -Ao args=`
      // printed a sibling's full argv - so a session created while another agent polls `ps` hands
      // that agent the operator's API key. The tens of milliseconds the tmux client lives are
      // enough.
      //
      // So the values go in the tmux CLIENT's own environment (below, as the second argument to
      // #tmux), and `update-environment` names which of them tmux copies into the new session.
      // That copy happens as the session is created, and the pane is forked from it, so the agent
      // gets the values; the same chained invocation then empties the name list again and unsets
      // each variable from the session environment, so the reader gets nothing. One invocation
      // because a second call is a window in which both are readable. Verified by hand on tmux
      // 3.7b: the pane saw the value, `show-environment -t` was empty, and `ps` showed only names.
      const names = Object.keys(env);
      const updateArgs =
        names.length > 0
          ? ["set-option", "-g", "update-environment", names.join(" "), ";"]
          : ([] as string[]);
      const unsetArgs = Object.keys(env).flatMap((k) => [
        ";",
        "set-environment",
        "-t",
        exactTarget(id),
        "-u",
        k,
      ]);
      // The whole invocation is wrapped anyway: node puts the full argv into the rejection message
      // of a failed execFile, tmux's own stderr can quote a value back, and that message reaches
      // the client verbatim through the generic 500 in `createHandler`. Any non-zero exit does it:
      // a socket tmux refuses to connect to, a fork failure, or a failure in the chained
      // set-option/set-environment, since chaining fails the whole call.
      try {
        await this.#tmux(
          [
            ...updateArgs,
            "new-session",
            "-d",
            "-A",
            "-s",
            id,
            "-c",
            cwd,
            "--",
            command,
            ...args,
            // Set per session rather than relying on a global: a session created by a human by
            // hand must behave the same as one the server made, and the server cannot assume its
            // own tmux.conf reached a server someone else started.
            ";",
            "set-option",
            "-t",
            exactWindowTarget(id),
            "remain-on-exit",
            "on",
            // Back to empty in the same breath: the name list is for this one creation, and a
            // list left standing would copy the NEXT client's variables of those names into the
            // next session.
            ";",
            "set-option",
            "-g",
            "update-environment",
            "",
            ...unsetArgs,
          ],
          env,
        );
      } catch (error) {
        // The chain aborts where it failed, so the name list can be left standing. Emptying it is
        // best-effort: if this fails too, the create already failed and the original error is the
        // one worth reporting.
        if (names.length > 0) {
          await this.#tmux(["set-option", "-g", "update-environment", ""]).catch(() => undefined);
        }
        throw new Error(redactSecrets(messageOf(error), Object.values(env)));
      }
    }
    return { attached: existed };
  }

  async has(id: string): Promise<boolean> {
    return (await this.list()).some((session) => session.id === id);
  }

  /**
   * Make sure a tmux server exists, and that it will stay.
   *
   * `exit-empty` is on by default, which means the server terminates as soon as it holds no
   * sessions - so `start-server` succeeds and the server is gone before anything can use it.
   * That is not a hypothetical: it presented as a health check reporting "no server running"
   * moments after the entrypoint logged that the server was up.
   *
   * Idempotent, so it costs nothing when an entrypoint has already done this. Running it here
   * too is what lets the server work standalone - without it, `/api/health` reports 503 at boot
   * on any machine where nothing else started tmux first.
   */
  async ensureServer(): Promise<void> {
    // ONE invocation, with tmux's own `;` separator. As two calls this is a race it loses every
    // time: `start-server` succeeds, the brand-new server has no sessions, exit-empty is still on
    // by default, so it exits - and `set-option` then fails with "no server running on ...".
    // Chaining means the option is set before tmux gets to the point of deciding it is idle.
    //
    // `update-environment` is emptied in the same breath, and it is the second half of building a
    // session's environment explicitly. Its default copies SSH_AUTH_SOCK, DISPLAY and friends out
    // of whichever CLIENT creates or attaches to a session and into that session's environment -
    // so a clean server global environment alone would still hand a pane the forwarded ssh-agent
    // the moment we attached to it. Observed on tmux 3.7b: with the default,
    // `show-environment -t` listed SSH_AUTH_SOCK; emptied, it lists only what `-e` put there.
    //
    await this.#tmux([
      "start-server",
      ";",
      "set-option",
      "-g",
      "exit-empty",
      "off",
      ";",
      "set-option",
      "-g",
      "update-environment",
      "",
    ]);
    await this.#clearInheritedGlobalEnv();
  }

  /**
   * Strip the global environment of a server we did not start.
   *
   * `start-server` is a no-op against a socket that already has a live server, so on that path
   * the only half of the environment we build is the client's - and the server's global
   * environment is whatever shell started it. Every pane forked afterwards inherits it. The
   * trigger is ordinary rather than exotic: `CwdAllowlist.refusal()` and the README both tell
   * the operator to run `tmux -L agentdeck attach` to reach an orphaned session, and
   * `attach-session` starts a server if none is running. `exit-empty off` then keeps that
   * server alive indefinitely.
   *
   * Emptying `update-environment` above makes this worse rather than better, which is why it
   * cannot be left as a documented residual. tmux's default list names SSH_AUTH_SOCK, so the
   * default behaviour was overwriting it from our clean client - and removing the list removes
   * that accident. Verified by hand on tmux 3.7b: with a server started from a shell holding
   * SSH_AUTH_SOCK and a marker variable, a pane created exactly as `createOrAttach` builds it
   * saw both. The same test after the unset below saw neither.
   */
  async #clearInheritedGlobalEnv(): Promise<void> {
    const shown = await this.#tmux(["show-environment", "-g"]).catch(() => "");
    // `show-environment` prints `NAME=value`, or `-NAME` for one it records as removed. A
    // removed name is already unset, so only the assignments are worth a command.
    const inherited = shown
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("-"))
      .map((line) => line.slice(0, line.indexOf("=")))
      // PWD is tmux's own doing, not an inheritance: it is in the global environment of a server
      // we started ourselves with a built environment, so sweeping it would make the log line
      // below fire on every ordinary boot and mean nothing. A pane's working directory comes from
      // `new-session -c` regardless.
      .filter((name) => name !== "" && name !== "PWD" && !BASE_ENV_NAMES.includes(name));
    if (inherited.length === 0) return;

    // One invocation, tmux's own `;` between commands and none trailing - a dangling separator
    // is a command tmux cannot parse.
    const args: string[] = [];
    for (const name of inherited) {
      if (args.length > 0) args.push(";");
      args.push("set-environment", "-g", "-u", name);
    }
    await this.#tmux(args);
    // Say it out loud. A run that had to clean up after another server is the run where the
    // environment was not ours to begin with, and that is worth seeing in the log rather than
    // inferring later from a pane that has something it should not.
    console.error(
      `agentdeck: cleared ${String(inherited.length)} inherited variable(s) from the tmux server's ` +
        `global environment: ${inherited.join(", ")}`,
    );
  }

  /**
   * Every session tmux holds, with the fields the state machine needs.
   *
   * `#{pane_dead}` and `#{pane_dead_status}` are the definitive signal - a process that exited
   * gives `exited` plus its code, and no inference is involved.
   */
  async list(): Promise<TmuxSession[]> {
    let stdout: string;
    try {
      stdout = await this.#tmux([
        "list-sessions",
        "-F",
        [
          "#{session_name}",
          "#{pane_dead}",
          "#{pane_dead_status}",
          "#{session_created}",
          // Where tmux says this session is. The allowlist is matched against THIS rather than
          // against a remembered cwd, because a session name is a pure function of (path, agent)
          // and so is forgeable by anything that can write the socket.
          "#{session_path}",
        ].join(SEP),
      ]);
    } catch (error) {
      // "no server running" and "no sessions" are both non-zero exits, and only one is a failure.
      // An empty list is the normal state at boot, not an error to propagate.
      if (isEmptyTmux(error)) return [];
      throw error;
    }

    return stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [id = "", dead = "0", status = "", created = "0", path = ""] = line.split(SEP);
        return {
          id,
          path,
          dead: dead === "1",
          // An empty dead_status is not zero: tmux leaves it blank for a live pane, and reporting
          // "exited 0" for a running agent would be a confidently wrong answer.
          exitCode: dead === "1" && status !== "" ? Number(status) : undefined,
          startedAt: Number(created) * 1000,
        };
      });
  }

  async kill(id: string): Promise<void> {
    try {
      await this.#tmux(["kill-session", "-t", exactTarget(id)]);
    } catch (error) {
      // Killing a session that is already gone is the desired end state, not a failure.
      if (!isMissingSession(error) && !isEmptyTmux(error)) throw error;
    }
  }

  /** Scrollback that has already left the pane. Lines, not terminal state - see plan 002. */
  async captureHistory(id: string, lines: number): Promise<string> {
    try {
      return await this.#tmux([
        "capture-pane",
        "-p",
        "-e",
        "-t",
        exactWindowTarget(id),
        "-S",
        `-${String(lines)}`,
        "-E",
        "-1",
      ]);
    } catch (error) {
      if (isMissingSession(error) || isEmptyTmux(error)) return "";
      throw error;
    }
  }

  /** Make tmux repaint the live screen into the stream we are already reading. */
  async refresh(id: string): Promise<void> {
    // `-t` here is a CLIENT target, not a session one, so it is not one of the targets that can
    // resolve to somebody else's session. Left as it is.
    await this.#tmux(["refresh-client", "-t", id, "-R"]);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.#tmux([
      "resize-window",
      "-t",
      exactWindowTarget(id),
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
  }
}

/**
 * Take every secret VALUE out of a message, wherever it appears.
 *
 * By value rather than by `-e NAME=` shape: the same string can appear in the argv, in tmux's own
 * stderr, and quoted differently in each, and a message that leaks the secret in one of those is
 * as leaked as one that leaks it in all three. Empty values are skipped - replacing "" would
 * rewrite the whole string.
 */
export const redactSecrets = (text: string, values: readonly string[]): string => {
  let out = text;
  for (const value of values) {
    if (value === "") continue;
    out = out.split(value).join("<redacted>");
  }
  return out;
};

const messageOf = (error: unknown): string => {
  if (error === null || typeof error !== "object") return "";
  const record: { stderr?: unknown; message?: unknown } = error;
  // Only strings, deliberately: an object here would stringify to "[object Object]" and match
  // nothing, which would silently reclassify every error as "propagate".
  const parts = [record.stderr, record.message].filter((v) => typeof v === "string");
  return parts.join(" ");
};

// Three different sentences, all meaning "there is nothing here to list", and tmux picks between
// them by version and platform:
//
//   no server running on <socket>          the documented one
//   no sessions                            server up, holding none - the normal state at boot
//   error connecting to <socket> (No ...)   what tmux 3.7b on macOS actually says when the
//                                          socket file is absent
//
// The third was missed until the server was run for real, where it crashed startup instead of
// reporting an empty list. Worth stating plainly: this set is observed on the tmux 3.7b the Mac
// actually runs rather than assumed, and a fourth wording is likelier than not.
export const isEmptyTmux = (error: unknown): boolean =>
  /no server running|no sessions|error connecting to/i.test(messageOf(error));

export const isMissingSession = (error: unknown): boolean =>
  /can't find session|session not found/i.test(messageOf(error));
