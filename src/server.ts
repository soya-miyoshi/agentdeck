import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseProfiles } from "./agent-profiles.ts";
import { installHookSettings } from "./claude-hooks.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Hub } from "./hub.ts";
import { clientUrl, firstRunLines } from "./qr.ts";
import { runReaper, startReaping } from "./reap-schedule.ts";
import { Registry } from "./registry.ts";
import { withClient } from "./static.ts";
import { Tmux } from "./tmux.ts";
import { readTailnet, tailnetAdvice } from "./tailnet.ts";
import { generateToken } from "./token.ts";
import { UploadStore } from "./uploads.ts";
import { attachWebSocketServer } from "./ws.ts";

const run = promisify(execFile);

const VERSION = "0.0.0";
const HEALTH_TIMEOUT_MS = 3000;

// Depth of scrollback a cold snapshot carries. Not a knob: plan 002 refuses pagination outright,
// so this is the one fixed depth, and reading further back would be a plan rather than a param.
const HISTORY_LINES = 2000;

// The built client, served unauthenticated on every path no API or socket route owns (plan 001).
// Relative to this file rather than the working directory: one process serves one build.
const CLIENT_DIR = resolve(import.meta.dirname, "..", "dist", "client");

// How often the hub reconciles against tmux - what makes a hand-started session appear and notices
// an agent that exited unwatched. One `list-sessions`, so it can afford to be frequent.
const SYNC_INTERVAL_MS = 2000;

/**
 * Where the bearer token lives unless `AGENTDECK_TOKEN_FILE` says otherwise: a directory the user
 * owns, that no session is pointed at, and that exists with no environment variable set.
 */
export const defaultTokenFile = (): string => join(homedir(), ".agentdeck", "token");

/**
 * The path a write to `p` would actually land on, symlinks followed. A lexical `resolve` is blind
 * to a symlink and `writeFileSync` is not, so a link is how the refusals below were bypassed.
 */
const wouldLandOn = (p: string, hops = 0): string => {
  const full = resolve(p);
  // The whole path, when everything on it exists - the case a link to an existing target takes.
  try {
    return realpathSync(full);
  } catch {
    // Falls through: something on the path does not exist yet, which is the ordinary first run.
  }
  // The LEAF may be a symlink whose target does not exist yet, which is how the bypass was planted:
  // `realpath` of the directory cannot see it, because the link is not in the directory's path.
  try {
    if (lstatSync(full).isSymbolicLink() && hops < 32) {
      return wouldLandOn(resolve(dirname(full), readlinkSync(full)), hops + 1);
    }
  } catch {
    // Not a link, or gone between the two calls.
  }
  // Neither exists, so resolve as much of the parent chain as does.
  const parts: string[] = [basename(full)];
  let dir = dirname(full);
  for (;;) {
    try {
      return join(realpathSync(dir), ...parts.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return full;
      parts.push(basename(dir));
      dir = parent;
    }
  }
};

export const tokenInsideAllowlist = (
  tokenPath: string,
  allowedPaths: readonly string[],
): string | undefined => {
  const token = wouldLandOn(tokenPath);
  return allowedPaths.find((allowed) => {
    const root = wouldLandOn(allowed);
    return token === root || token.startsWith(`${root}/`);
  });
};

/**
 * The token, generated on first run and stored 0600.
 */
export const loadToken = (path: string): string => {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  } catch {
    // Absent is the first-run case, not an error.
  }
  const token = generateToken();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  } catch (error) {
    // An unhandled EACCES names no variable and offers no next step, which is how a token ends up
    // wherever happened to be writable.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not write the bearer token to ${path}: ${reason}. Set AGENTDECK_TOKEN_FILE to a ` +
        `path this user can write. Not inside a directory a session is pointed at: an agent's ` +
        `own \`ls -la\` or \`grep -rn token .\` would put the token in a transcript.`,
    );
  }
  return token;
};

/**
 * Liveness, not correctness (plan 006): a hard-timed tmux round trip from the same event loop that
 * serves the app. It touches no agent - a check that depends on one behaving costs sessions.
 */
const probeTmux = async (socket: string): Promise<boolean> => {
  try {
    await run("tmux", ["-L", socket, "list-sessions"], { timeout: HEALTH_TIMEOUT_MS });
    return true;
  } catch (error) {
    const text =
      error instanceof Error ? `${error.message}${String(Reflect.get(error, "stderr") ?? "")}` : "";
    // An empty server is healthy; a missing one is not. Both are non-zero exits from tmux.
    return /no sessions/i.test(text);
  }
};

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const main = async (): Promise<void> => {
  const socket = env("TMUX_SOCKET", "agentdeck");
  const port = Number(env("AGENTDECK_PORT", "7777"));
  const tokenFile = env("AGENTDECK_TOKEN_FILE", defaultTokenFile());

  // Where a profile's relative `waiting.settings` lands (plan 004). A directory of agentdeck's own
  // is the only fallback it may write: the alternative rewrites the operator's live Claude config.
  const agentStateDir = env(
    "AGENTDECK_AGENT_STATE_DIR",
    join(homedir(), ".agentdeck", "agent-state"),
  );

  // Landing on the fallback silently is what to avoid: the strip promises `detectsWaiting` while
  // the fragment sits in a directory the agent was never pointed at, and never keeps it.
  if (process.env["AGENTDECK_AGENT_STATE_DIR"] === undefined) {
    console.error(
      `agentdeck: AGENTDECK_AGENT_STATE_DIR is not set, so hook settings go to ${agentStateDir}. ` +
        `An agent only reads them if it is pointed there - for claude, CLAUDE_CONFIG_DIR in its ` +
        `profile's env. Until then, agents configured with waiting.via=hook report "detects ` +
        `waiting" and never report waiting.`,
    );
  }

  // The Origin check is present-but-off with no expected origin, so say so at boot. The tailnet is
  // read here (plan 006) so the advice names the real ts.net origin rather than a placeholder.
  const tailnet = await readTailnet();
  if (process.env["AGENTDECK_ORIGIN"] === undefined) {
    console.error(
      "agentdeck: AGENTDECK_ORIGIN is not set, so the Origin check plan 001 describes is off. " +
        "Any page a browser visits can call /api and open /ws with a token it has. Set it to the " +
        "https://<host>.ts.net origin the phone loads.",
    );
  }
  for (const line of tailnetAdvice(tailnet, port, process.env["AGENTDECK_ORIGIN"]))
    console.error(line);

  // Images the phone sends into a session, beside the token rather than inside any repository:
  // a screenshot is not the work, and a session's tree is what a git remote protects.
  const uploads = new UploadStore(
    env("AGENTDECK_UPLOAD_DIR", join(homedir(), ".agentdeck", "uploads")),
  );

  const paths = (name: string): string[] =>
    env(name, "")
      .split(":")
      .filter((entry) => entry !== "");

  // AGENTDECK_ROOTS is read on every request rather than captured here, so a clone made while the
  // server runs is startable with no restart. MOUNTS stays for directories outside any root.
  const mounts = paths("AGENTDECK_MOUNTS");
  const roots = paths("AGENTDECK_ROOTS");
  const allowlist = new CwdAllowlist(mounts, roots);
  if (mounts.length === 0 && roots.length === 0) {
    console.error(
      "agentdeck: neither AGENTDECK_MOUNTS nor AGENTDECK_ROOTS is set, so the allowlist is " +
        "empty: no session can start and every live one is filtered off /api/sessions. Set " +
        "AGENTDECK_ROOTS to a directory holding repositories - `ghq root` is one - and clones " +
        "under it become startable with no restart.",
    );
  }

  // `dist/client` is published with NO bearer token - the page must load before a token exists -
  // so a file there is downloadable at a URL equal to its filename. Refused, with no degraded mode.
  const published = [tokenFile, process.env["AGENTDECK_PROFILES"]]
    .filter((path): path is string => path !== undefined)
    .find((path) => tokenInsideAllowlist(path, [CLIENT_DIR]) !== undefined);
  if (published !== undefined) {
    console.error(
      `agentdeck: ${resolve(published)} is inside ${CLIENT_DIR}, which this server publishes ` +
        `UNAUTHENTICATED on every path that is not an API route - the page has to load before a ` +
        `token exists. Anything under that directory is downloadable by any device that can reach ` +
        `the port, at a URL equal to its filename. Move it - the default, ${defaultTokenFile()}, ` +
        `is outside it.`,
    );
    process.exit(1);
  }

  // A root counts as well as an allowlisted repository: a clone made tomorrow would swallow a file
  // sitting there, with no boot left to notice it.
  const trees = [...allowlist.paths, ...allowlist.roots];
  const source = (tree: string): string =>
    allowlist.roots.includes(tree) ? "AGENTDECK_ROOTS" : "AGENTDECK_MOUNTS";

  const clash = tokenInsideAllowlist(tokenFile, trees);
  if (clash !== undefined) {
    console.error(
      `agentdeck: the bearer token file ${resolve(tokenFile)} is inside ${clash}, which sessions ` +
        `are started in. An agent started there meets the token in an ordinary \`ls -la\` ` +
        `or \`grep -rn token .\`, and that token starts sessions in every allowed repository, ` +
        `kills live ones, and attaches to every other agent's terminal. Move it - the default, ` +
        `${defaultTokenFile()}, is outside every allowlist entry - or take that entry off ` +
        `${source(clash)}.`,
    );
    process.exit(1);
  }

  let profilesRaw: unknown = {};
  const profilesPath = process.env["AGENTDECK_PROFILES"];
  // The same rule as the token file, for a more direct host-execution surface: `command` and `args`
  // go unmodified into `tmux new-session --` and run as the human, and no review command reads it.
  if (profilesPath !== undefined) {
    const profilesClash = tokenInsideAllowlist(profilesPath, trees);
    if (profilesClash !== undefined) {
      console.error(
        `agentdeck: the agent profiles file ${resolve(profilesPath)} is inside ${profilesClash}, ` +
          `which sessions are started in. That file decides what command every session runs, ` +
          `as this user, so an agent started there can choose what the next session executes. ` +
          `Move it outside every allowlist entry, or take that entry off ${source(profilesClash)}.`,
      );
      process.exit(1);
    }
    try {
      profilesRaw = JSON.parse(readFileSync(profilesPath, "utf8"));
    } catch (error) {
      // A broken profiles file must not take the server down - it would take away every session
      // to fix a config typo. Log and serve zero agents; the picker shows nothing startable.
      console.error(`agentdeck: could not read ${profilesPath}:`, error);
    }
  }
  const { profiles, rejected } = parseProfiles(profilesRaw);
  for (const { id, reason } of rejected)
    console.error(`agentdeck: profile ${id} rejected: ${reason}`);
  for (const profile of profiles.values()) {
    if (profile.waitingDisabledReason !== undefined) {
      console.error(
        `agentdeck: ${profile.id} waiting mechanism disabled: ${profile.waitingDisabledReason}`,
      );
    }
  }

  // Once, not per session: one agent-state directory is one settings file shared by every session
  // of that agent. What varies per session is the id and the secret, which go via the environment.
  for (const profile of profiles.values()) {
    if (profile.waiting?.via !== "hook") continue;
    // Always under the agent-state directory: written at every boot, so an absolute or climbing
    // path would be an arbitrary JSON write aimed wherever a profiles file said.
    const settingsPath = join(agentStateDir, profile.waiting.settings);
    try {
      const { changed } = installHookSettings(settingsPath, port);
      console.log(
        `agentdeck: ${profile.id} hooks ${changed ? "merged into" : "already present in"} ${settingsPath}`,
      );
    } catch (error) {
      // A fragment that will not merge disables the MECHANISM, not the profile: that agent drops to
      // working/idle/exited and stays startable, and the human's own edit is left alone.
      console.error(`agentdeck: ${profile.id} hook install failed for ${settingsPath}:`, error);
    }
  }

  // Asked before `loadToken` creates the file, and asked the way `loadToken` asks it rather than
  // with `existsSync`: the two disagree on an empty file, which mints a new token silently.
  const firstRun = ((): boolean => {
    try {
      return readFileSync(tokenFile, "utf8").trim() === "";
    } catch {
      return true;
    }
  })();

  let token: string;
  try {
    token = loadToken(tokenFile);
  } catch (error) {
    console.error(`agentdeck: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const tmux = new Tmux({ socket });
  // Before anything asks tmux a question, and idempotent. Without it /api/health reports 503 at
  // boot on any machine where nothing else started tmux first.
  await tmux.ensureServer();

  const registry = new Registry(tmux, profiles, allowlist, token);
  const hub = new Hub({
    tmux,
    registry,
    socket,
    // `state` is pushed rather than polled (plan 002), and both sources - the hub's inference and
    // an agent's hook - go out through this one funnel. `ws` is declared below; nothing syncs first.
    onState: (id, state, exitCode) => {
      ws.pushState(id, state, exitCode);
    },
  });

  // Reaping at start rather than on a timer: "exited 1" is the answer to "did it finish, or did I
  // lose it". A tmux that will not answer at boot is no reason to refuse to serve.
  try {
    const reaped = await registry.reap();
    if (reaped.length > 0)
      console.log(`agentdeck: reaped ${String(reaped.length)} dead session(s)`);
  } catch (error) {
    console.error("agentdeck: reap at boot failed, continuing:", error);
  }

  const server = createServer(
    withClient(
      createHandler({
        onSessionsChanged: () => {
          hub.sync().catch((error: unknown) => {
            console.error("agentdeck: sync failed:", error);
          });
        },
        registry,
        profiles,
        allowlist,
        token,
        version: VERSION,
        origin: process.env["AGENTDECK_ORIGIN"],
        probe: async () => await probeTmux(socket),
        panePids: async () => await tmux.panePids(),
        streamFor: (id) => hub.streamFor(id),
        uploads,
        onStateDeclared: (id, state) => {
          // A `#meta` entry outlives the session's membership of `list()`, so without this an
          // off-allowlist session's state reaches every socket. `sync()` adopted set is the right one.
          if (!hub.attached(id)) return;
          hub.announce(id, state);
        },
      }),
      CLIENT_DIR,
    ),
  );

  const ws = attachWebSocketServer(server, {
    token,
    origin: process.env["AGENTDECK_ORIGIN"],
    streamFor: (id) => hub.streamFor(id),
    listSessions: async () => await registry.list(),
    captureHistory: async (id) => await hub.captureHistory(id, HISTORY_LINES),
    isAlternateScreen: async (id) => await hub.isAlternateScreen(id),
    repaint: async (id) => await hub.repaint(id),
    sendInput: (id, data) => hub.sendInput(id, data),
    applyPaneRows: (id, rows) => hub.applyPaneRows(id, rows),
  });

  // Attach to what tmux already has before serving, so the first request sees real state. A failed
  // poll is one stale tick, never an exited process: nothing supervises this one.
  try {
    await hub.sync();
  } catch (error) {
    console.error("agentdeck: initial sync failed, retrying on the next tick:", error);
  }
  const syncTimer = setInterval(() => {
    hub.sync().catch((error: unknown) => {
      console.error("agentdeck: sync failed:", error);
    });
  }, SYNC_INTERVAL_MS);
  syncTimer.unref();

  // A port already in use is the most ordinary startup failure there is, and Node's default is an
  // unhandled 'error' event with no sentence saying which port or what to do.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `agentdeck: port ${String(port)} is already in use. Another agentdeck, or something ` +
          `else on this Mac. Stop it, or set AGENTDECK_PORT to a free port.`,
      );
      process.exit(1);
    }
    console.error("agentdeck: server error:", error.message);
    process.exit(1);
  });

  // Loopback only. `tailscale serve` on the host is the single place where remote exposure is
  // decided, and binding the tailnet address here would make that two places.
  await new Promise<void>((listening) => server.listen(port, "127.0.0.1", listening));
  console.log(`agentdeck: listening on 127.0.0.1:${String(port)}`);
  // The startable count rather than the mount count: with roots configured, "0 mount(s)" reads as
  // an empty allowlist while a dozen repositories are startable.
  console.log(
    `agentdeck: ${String(profiles.size)} agent profile(s), ` +
      `${String(allowlist.paths.length)} startable directory(ies) from ` +
      `${String(mounts.length)} mount(s) and ${String(roots.length)} root(s)`,
  );

  // Last, after the boot warnings, so the QR is what is on the screen when a person turns to the
  // terminal with a phone in their hand rather than something they have to scroll back to.
  if (firstRun) {
    for (const line of firstRunLines(
      token,
      clientUrl(process.env["AGENTDECK_ORIGIN"], port),
      tokenFile,
      process.stdout.isTTY === true,
    ))
      console.log(line);
  }

  // Collecting what sessions leave behind, for as long as this process is up - the deck is the gate
  // rather than a launchd job. Announced rather than silent, because it kills processes.
  const reapEveryMs = Number(env("AGENTDECK_REAP_INTERVAL_MS", String(60 * 60 * 1000)));
  let stopReaping = (): void => {};
  if (
    Number.isFinite(reapEveryMs) &&
    reapEveryMs > 0 &&
    allowlist.roots.length + mounts.length > 0
  ) {
    stopReaping = startReaping(reapEveryMs, runReaper(process.env), (line) => {
      console.log(line);
    });
    // Seconds below a minute: a 700ms interval reported as "every 0 minute(s)" is a sentence that
    // makes the operator doubt the number they set.
    const every =
      reapEveryMs < 60_000
        ? `${String(Math.round(reapEveryMs / 1000))} second(s)`
        : `${String(Math.round(reapEveryMs / 60000))} minute(s)`;
    console.log(
      `agentdeck: collecting abandoned processes under the roots every ${every}. ` +
        `AGENTDECK_REAP_INTERVAL_MS=0 turns it off; \`make reap\` shows what it would take ` +
        `without taking it.`,
    );
  }

  const shutdown = (): void => {
    clearInterval(syncTimer);
    stopReaping();
    ws.close();
    // Detach from every session without killing anything. The agents keep running; this process
    // going away must not be the thing that ends someone's work.
    hub.disposeAll();
    server.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

// Only when run directly, so importing this module in a test does not start a listener.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))
) {
  await main();
}
