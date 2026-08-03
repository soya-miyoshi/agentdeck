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
      (async (args) => await run("tmux", ["-L", this.socket, ...args], { encoding: "utf8" }));
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
      ]);
      // Set per session rather than relying on a global: a session created by a human by hand
      // must behave the same as one the server made, and the server cannot assume its own
      // tmux.conf reached a server someone else started.
      await this.#tmux(["set-option", "-t", id, "remain-on-exit", "on"]);
    }
    return { attached: existed };
  }

  async has(id: string): Promise<boolean> {
    return (await this.list()).some((session) => session.id === id);
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

export const isEmptyTmux = (error: unknown): boolean =>
  /no server running|no sessions/i.test(messageOf(error));

export const isMissingSession = (error: unknown): boolean =>
  /can't find session|session not found/i.test(messageOf(error));
