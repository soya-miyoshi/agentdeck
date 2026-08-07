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
}

// A field separator that cannot appear in the values being formatted. tmux format strings are
// substituted before we see them, so a separator a session name could contain would let a
// crafted name forge extra fields.
const SEP = "\u001f";

export interface TmuxOptions {
  socket: string;
  /** Injected so tests can drive the parser without a tmux server. */
  exec?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export class Tmux {
  readonly socket: string;
  #exec: (args: string[]) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: TmuxOptions) {
    this.socket = options.socket;
    this.#exec =
      options.exec ??
      (async (args) =>
        // `env` rather than the inherited one, and this is the load-bearing half of it: the tmux
        // SERVER is a child of whichever of these calls starts it, so its global environment -
        // which every pane inherits - is this object.
        await run("tmux", ["-L", this.socket, ...args], { encoding: "utf8", env: baseEnv() }));
  }

  async #tmux(args: string[]): Promise<string> {
    const { stdout } = await this.#exec(args);
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
      // -d so creating a session does not attach this process to it. Environment is passed with
      // repeated -e rather than through our own environment, so one session's secret never
      // becomes another's.
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      // ...and then taken straight back out of the session environment, which is the only reason
      // these three run as one invocation.
      //
      // `-e` puts a variable in the SESSION environment, and tmux keeps it there: any same-uid
      // process could then read the per-session hook secret and every profile-passed API key with
      // `tmux -L <socket> show-environment -t <session>`. No ptrace, no debugger, and on macOS no
      // `/proc/<pid>/environ` either - `ps` does not show another process's environment. tmux
      // builds the pane's environment when the pane is forked, which new-session has already done
      // by the time set-environment runs, so unsetting afterwards takes the value away from the
      // reader and not from the agent. Verified by hand on tmux 3.7b: the pane saw the secret,
      // `show-environment -t` did not.
      const unsetArgs = Object.keys(env).flatMap((k) => [
        ";",
        "set-environment",
        "-t",
        id,
        "-u",
        k,
      ]);
      await this.#tmux([
        "new-session",
        "-d",
        "-A",
        "-s",
        id,
        "-c",
        cwd,
        ...envArgs,
        "--",
        command,
        ...args,
        // Set per session rather than relying on a global: a session created by a human by hand
        // must behave the same as one the server made, and the server cannot assume its own
        // tmux.conf reached a server someone else started.
        ";",
        "set-option",
        "-t",
        id,
        "remain-on-exit",
        "on",
        ...unsetArgs,
      ]);
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
    // What this does NOT reach: a tmux server someone else already started on this socket. Its
    // global environment is whatever shell started it, and tmux has no way to clear that. The
    // option above is re-applied on every boot, so the client half is covered either way.
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
        ["#{session_name}", "#{pane_dead}", "#{pane_dead_status}", "#{session_created}"].join(SEP),
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
        const [id = "", dead = "0", status = "", created = "0"] = line.split(SEP);
        return {
          id,
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
      await this.#tmux(["kill-session", "-t", id]);
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
        id,
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
    await this.#tmux(["refresh-client", "-t", id, "-R"]);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.#tmux(["resize-window", "-t", id, "-x", String(cols), "-y", String(rows)]);
  }
}

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
