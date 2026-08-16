import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { endTree, readProcessTable, treeOf } from "./processes.ts";

const run = promisify(execFile);

// The tmux side of the session registry: every session is `tmux new-session -A`, so one call either
// starts it or reattaches. `remain-on-exit on` and `exit-empty off` are both load-bearing (audit.md).

export type SessionState = "working" | "waiting" | "idle" | "exited";

/**
 * The only variable names a tmux server we start carries, and so all a pane inherits unasked.
 * The WHOLE environment rather than an addition to the shell's; without it panes saw SSH_AUTH_SOCK.
 */
export const BASE_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  // LC_CTYPE is not decoration and not a nicety: see `baseEnv` below, where it is defaulted.
  "LC_CTYPE",
  "TMPDIR",
  "USER",
  "LOGNAME",
];

/**
 * The environment every tmux invocation gets, and so the server one of them starts. `TERM` and
 * `LC_CTYPE` are defaulted: tmux rewrites `list()`'s U+001F to `_` for a non-UTF-8 client.
 */
export const baseEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out["TERM"] ??= "xterm-256color";
  // POSIX precedence, not "any of the three says UTF-8": that reading gets `LC_ALL=C` and
  // `LANG=en_US.UTF-8 LC_CTYPE=C` wrong, and both produce the mangled output above.
  const winner = ["LC_ALL", "LC_CTYPE", "LANG"].find((name) => out[name] !== undefined);
  if (winner === undefined || !/utf-?8/i.test(out[winner] ?? "")) {
    // Built from scratch, so an LC_ALL that would outrank the default is dropped rather than kept.
    delete out["LC_ALL"];
    out["LC_CTYPE"] = "UTF-8";
  }
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
 * An EXACT tmux target. `-t name` resolves by exact name, then prefix, then fnmatch, so a stale id
 * from a client would otherwise kill whatever happens to share its prefix.
 */
export const exactTarget = (id: string): string => `=${id}`;

/**
 * The same for a command whose `-t` is a window or pane target: `=name` alone is not one.
 * The trailing colon is what means "this session, its current window", exactly.
 */
export const exactWindowTarget = (id: string): string => `=${id}:`;

/**
 * Turn what `capture-pane` prints into bytes a terminal can be written with.
 * It separates lines with LF alone, and the terminal is not in `convertEol`, so history staircased.
 */
export const forTerminal = (captured: string): string =>
  captured
    .split("\n")
    // The CR comes off first so the join can put exactly one back, whatever the capture used.
    .map((line) => line.replace(/\r$/, ""))
    // eslint-disable-next-line no-control-regex -- ESC is exactly the character being matched.
    .map((line) => line.replace(/ +((?:\u001b\[[0-9;]*m)*)$/, "$1"))
    .join("\r\n");

// A field separator no value can contain. tmux substitutes format strings before we see them, so a
// separator a session name could hold would let a crafted name forge extra fields.
const SEP = "\u001f";

/**
 * agentdeck's own tmux config, passed as `-f` so `~/.tmux.conf` is never read on this socket.
 * It reaches only a server WE start, so `ensureServer` re-applies what must hold either way.
 */
export const CONFIG_FILE = resolve(import.meta.dirname, "..", "tmux.conf");

export interface TmuxOptions {
  socket: string;
  /** Overridden only by tests that need a server with no config at all. */
  configFile?: string;
  /**
   * Injected so tests can drive the parser without a tmux server. `extra` is separate because a
   * session's values travel in the client's environment rather than its argv - see `createOrAttach`.
   */
  exec?: (
    args: string[],
    extra?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export class Tmux {
  readonly socket: string;
  readonly #configFile: string;
  #exec: (
    args: string[],
    extra?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: TmuxOptions) {
    this.socket = options.socket;
    this.#configFile = options.configFile ?? CONFIG_FILE;
    this.#exec =
      options.exec ??
      (async (args, extra) =>
        // `env` rather than the inherited one: the tmux SERVER is a child of whichever call starts
        // it, so this object is the global environment every pane inherits. `-f` must come first.
        await run("tmux", ["-f", this.#configFile, "-L", this.socket, ...args], {
          encoding: "utf8",
          env: { ...baseEnv(), ...extra },
          // execFile's 1MB default is under `capture-pane -e` over HISTORY_LINES, and exceeding it
          // rejects with an error that is neither a missing session nor an empty server.
          maxBuffer: 16 * 1024 * 1024,
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
      // A server must EXIST before the client carrying the secrets runs: whichever client starts one
      // donates its whole environment to the server's GLOBAL one, which no per-session unset clears.
      await this.ensureServer();
      // -d so this process does not attach, and the values ride the tmux CLIENT's environment rather
      // than `-e` or argv (both readable): `update-environment` copies them in, then unsets them.
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
      // Wrapped because node puts the full argv into a failed execFile's message and tmux can quote
      // a value back, and that message reaches the client verbatim through `createHandler`'s 500.
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
            // Per session rather than global: our tmux.conf may never have reached this server, and
            // a hand-started session must behave the same as one the server made.
            ";",
            "set-option",
            "-t",
            exactWindowTarget(id),
            "remain-on-exit",
            "on",
            // Back to empty in the same breath: a list left standing would copy the NEXT client's
            // variables of those names into the next session.
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
        // The chain aborts where it failed, so the name list can be left standing. Best-effort:
        // the create already failed, and its error is the one worth reporting.
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
   * Make sure a tmux server exists and will stay: `exit-empty` is on by default, so a started
   * server is gone before anything can use it. Idempotent.
   */
  async ensureServer(): Promise<void> {
    // ONE invocation with tmux's own `;`: as two calls the brand-new server exits before
    // `set-option` lands. Emptying `update-environment` stops tmux copying SSH_AUTH_SOCK off a client.
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
      // The prefix is a COMMAND CHANNEL and every byte from the phone reaches it: with the default
      // C-b, `Ctrl b :` then `run-shell` is host execution outside the allowlist. Verified on 3.7b.
      ";",
      "set-option",
      "-g",
      "prefix",
      "none",
      ";",
      "set-option",
      "-g",
      "prefix2",
      "none",
      // The tmux.conf settings that must also hold on a server we did NOT start, since `-f` reaches
      // only one this call starts: a `#()` status line runs shell commands on a timer inside it.
      ";",
      "set-option",
      "-g",
      "status",
      "off",
      ";",
      "set-option",
      "-g",
      "mouse",
      "off",
      ";",
      "set-option",
      "-g",
      "history-limit",
      "10000",
    ]);
    await this.#clearInheritedGlobalEnv();
  }

  /**
   * Strip the global environment of a server we did not start - attaching by hand starts one from
   * the operator's shell, and every pane forked afterwards inherits it.
   */
  async #clearInheritedGlobalEnv(): Promise<void> {
    const shown = await this.#tmux(["show-environment", "-g"]).catch(() => "");
    // `show-environment` prints `NAME=value`, or `-NAME` for one already recorded as removed.
    const inherited = shown
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("-"))
      .map((line) => line.slice(0, line.indexOf("=")))
      // PWD is tmux's own doing rather than an inheritance, so sweeping it would fire the log line
      // below on every ordinary boot. A pane's directory comes from `new-session -c` regardless.
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
    // Said out loud: a run that cleaned up after another server is one where the environment was
    // never ours, which beats inferring it later from a pane holding something it should not.
    console.error(
      `agentdeck: cleared ${String(inherited.length)} inherited variable(s) from the tmux server's ` +
        `global environment: ${inherited.join(", ")}`,
    );
  }

  /**
   * Each session's pane pid, the root of everything that session is running. This socket only -
   * the operator's own tmux is none of our business. Empty for "no server" and "no sessions".
   */
  async panePids(): Promise<{ sessionId: string; panePid: number }[]> {
    let stdout: string;
    try {
      stdout = await this.#tmux([
        "list-panes",
        "-a",
        "-F",
        ["#{session_name}", "#{pane_pid}"].join(SEP),
      ]);
    } catch (error) {
      if (isEmptyTmux(error)) return [];
      throw error;
    }
    const found: { sessionId: string; panePid: number }[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.includes(SEP)) continue;
      const at = line.lastIndexOf(SEP);
      const panePid = Number(line.slice(at + SEP.length).trim());
      const sessionId = line.slice(0, at);
      if (sessionId !== "" && Number.isInteger(panePid) && panePid > 1) {
        found.push({ sessionId, panePid });
      }
    }
    return found;
  }

  /**
   * Every session tmux holds, with the fields the state machine needs. `#{pane_dead}` and
   * `#{pane_dead_status}` are definitive - an exited process gives its code, with no inference.
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
          // Where tmux says this session is. The allowlist matches THIS rather than a remembered
          // cwd, because a session name is a pure function of (path, agent) and so forgeable.
          "#{session_path}",
        ].join(SEP),
      ]);
    } catch (error) {
      // "no server running" and "no sessions" are both non-zero exits, and only one is a failure.
      // An empty list is the normal state at boot, not an error to propagate.
      if (isEmptyTmux(error)) return [];
      throw error;
    }

    const lines = stdout.split("\n").filter((line) => line !== "");

    // Loud only for the locale mangling, where NO line carries a separator (see `baseEnv`). One
    // separator-less line is a path holding a newline, and must cost that session alone.
    if (lines.length > 0 && !lines.some((line) => line.includes(SEP))) {
      throw new Error(
        `tmux returned list-sessions output with no field separator: ${JSON.stringify(lines[0])}. ` +
          `tmux replaces non-printable bytes with "_" for a client whose locale is not UTF-8; ` +
          `set a UTF-8 locale for the process running agentdeck - and note LC_ALL outranks ` +
          `LC_CTYPE and LANG, so a non-UTF-8 LC_ALL must be changed or unset, not worked around.`,
      );
    }

    return lines
      .filter((line) => line.includes(SEP))
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

  /**
   * One session's path and creation time, by exact target. Not `list()`: the caller runs precisely
   * when that has failed. `undefined` when tmux cannot answer - a caller that cannot confirm stops.
   */
  async describe(id: string): Promise<{ path: string; startedAt: number } | undefined> {
    try {
      const stdout = await this.#tmux([
        "display-message",
        "-p",
        // A WINDOW target: `-t =name` answers with empty fields rather than an error, which reads
        // as "cannot confirm" and so silently disables the check this exists to make.
        "-t",
        exactWindowTarget(id),
        ["#{session_path}", "#{session_created}"].join(SEP),
      ]);
      const [path = "", created = ""] = stdout.trim().split(SEP);
      if (path === "" || created === "") return undefined;
      return { path, startedAt: Number(created) * 1000 };
    } catch {
      return undefined;
    }
  }

  /**
   * End the session AND everything it was running - `kill-session` alone leaves anything detached
   * reparented to launchd. The tree is read BEFORE the kill, since afterwards nothing links them.
   */
  async kill(id: string): Promise<void> {
    const doomed = await this.#treeOfSession(id);
    try {
      await this.#tmux(["kill-session", "-t", exactTarget(id)]);
    } catch (error) {
      // Killing a session that is already gone is the desired end state, not a failure.
      if (!isMissingSession(error) && !isEmptyTmux(error)) throw error;
    }
    if (doomed.length === 0) return;
    const survivors = await endTree(doomed);
    if (survivors.length > 0) {
      console.error(
        `agentdeck: closing ${id} left ${String(survivors.length)} process(es) that refused to ` +
          `die: ${survivors.join(", ")}`,
      );
    }
  }

  /**
   * Every pid in this session's pane trees, pane first. Empty when the session is already gone.
   * An exact string match, since `list-panes -t =<id>` still resolves by prefix and this feeds a kill.
   */
  async #treeOfSession(id: string): Promise<number[]> {
    const panes = (await this.panePids())
      .filter((entry) => entry.sessionId === id)
      .map((entry) => entry.panePid);
    if (panes.length === 0) return [];
    const rows = await readProcessTable();
    const found: number[] = [];
    for (const pane of panes) {
      for (const row of treeOf(rows, pane)) if (!found.includes(row.pid)) found.push(row.pid);
    }
    return found;
  }

  /**
   * Scrollback that has already left the pane. Lines, not terminal state - see plan 002.
   * NO `-J`: tmux flags every full-width row as wrapped, so it welds a TUI's lines together.
   */
  async captureHistory(id: string, lines: number): Promise<string> {
    try {
      return forTerminal(
        await this.#tmux([
          "capture-pane",
          "-p",
          "-e",
          "-t",
          exactWindowTarget(id),
          "-S",
          `-${String(lines)}`,
          "-E",
          "-1",
        ]),
      );
    } catch (error) {
      if (isMissingSession(error) || isEmptyTmux(error)) return "";
      throw error;
    }
  }

  /**
   * Whether the pane is on the alternate screen, where `capture-pane` returns the TUI rather than
   * history. `#{alternate_on}` prints clean ASCII even to a client with no locale set at all.
   */
  async isAlternateScreen(id: string): Promise<boolean> {
    try {
      const stdout = await this.#tmux([
        "display-message",
        "-p",
        "-t",
        exactWindowTarget(id),
        "#{alternate_on}",
      ]);
      return stdout.trim() === "1";
    } catch (error) {
      // A session that has gone has no alternate screen and no history either, so the answer the
      // caller acts on is the same one it would get from the capture that follows.
      if (isMissingSession(error) || isEmptyTmux(error)) return false;
      throw error;
    }
  }

  /**
   * Repaint the live screen into the stream we already read, so the snapshot's `seq` comes from it.
   * Every attached client, since anyone can attach a second one after `attach-session -d` ran.
   */
  async repaint(id: string): Promise<void> {
    const stdout = await this.#tmux(["list-clients", "-t", exactTarget(id), "-F", "#{client_tty}"]);
    const ttys = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (ttys.length === 0)
      throw new Error(`no tmux client is attached to ${id}, so it cannot repaint`);
    for (const tty of ttys) await this.#tmux(["refresh-client", "-t", tty, "-R"]);
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
 * Take every secret VALUE out of a message, wherever it appears - the same string is quoted
 * differently in argv and in tmux's stderr. Empty values are skipped; "" would rewrite everything.
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

// Three sentences that all mean "nothing here to list", picked between by version and platform.
// Observed on tmux 3.7b rather than assumed, so a fourth wording is likelier than not.
export const isEmptyTmux = (error: unknown): boolean =>
  /no server running|no sessions|error connecting to/i.test(messageOf(error));

export const isMissingSession = (error: unknown): boolean =>
  /can't find session|session not found/i.test(messageOf(error));
