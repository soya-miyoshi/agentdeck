import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { parseProfiles } from "./agent-profiles.ts";
import { installHookSettings } from "./claude-hooks.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Hub } from "./hub.ts";
import { Registry } from "./registry.ts";
import { Tmux } from "./tmux.ts";
import { generateToken } from "./token.ts";
import { attachWebSocketServer } from "./ws.ts";

const run = promisify(execFile);

const VERSION = "0.0.0";
const HEALTH_TIMEOUT_MS = 3000;

// Depth of scrollback a cold snapshot carries. Not a knob: plan 002 refuses pagination outright,
// so this is the one fixed depth, and reading further back would be a plan rather than a param.
const HISTORY_LINES = 2000;

// How often the hub reconciles against tmux. This is what makes a session someone started by
// hand in a terminal appear in the strip, and what notices an agent that exited while nobody was
// looking. Cheap - one `list-sessions` - so it can afford to be frequent.
const SYNC_INTERVAL_MS = 2000;

/**
 * The token, generated on first run and stored 0600.
 *
 * Where the path should be is open, recorded in plan 005's superseded header: the old answer was
 * reasoned from a container boundary that no longer exists. What survives is the requirement, not
 * the reasoning - this token starts sessions in any allowed repo, kills live ones, and attaches to
 * every other agent's terminal, and same uid means the mode hides nothing between the server and
 * the agents. So it is never at the root of a tree a session is pointed at, where `ls -la` or
 * `grep -rn token .` puts it in a transcript. Placement hides rather than isolates.
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
    // The default path is a leftover from the container and is not writable on a Mac, so this is
    // the first thing a plain `pnpm start` hits. An unhandled EACCES names no variable and offers
    // no next step, which is how a token ends up wherever happened to be writable - including the
    // one place it must not be. A sentence, like EADDRINUSE above it.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not write the bearer token to ${path}: ${reason}. Set AGENTDECK_TOKEN_FILE to a ` +
        `path this user can write. Not inside a directory a session is pointed at: an agent's ` +
        `own \`ls -la\` or \`grep -rn token .\` would put the token in a transcript. Where it ` +
        `should live now that there is no container is open - see plan 005's superseded header.`,
    );
  }
  return token;
};

/**
 * Liveness, not correctness (plan 006).
 *
 * Answers from the same event loop that serves the app - a separate thread would report health
 * the app does not have. Includes a hard-timed tmux round trip, because a server that cannot
 * reach tmux cannot do its job even though it looks fine. Touches no agent, no mount and no
 * network: a check that depends on a coding agent behaving produces false positives, and a false
 * positive here costs sessions.
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
  const tokenFile = env("AGENTDECK_TOKEN_FILE", "/var/lib/agentdeck/token");

  // Where a profile's relative `waiting.settings` lands: agentdeck's own agent-state directory,
  // named by AGENTDECK_AGENT_STATE_DIR rather than blindly the user's ~/.claude (plan 004). For
  // claude that is the same directory the agent reads, which CLAUDE_CONFIG_DIR points it at. The
  // fallback is deliberately somewhere disposable: a misconfigured server should merge into a
  // file nothing reads rather than into whichever config directory it happened to guess.
  const agentStateDir = env("AGENTDECK_AGENT_STATE_DIR", env("CLAUDE_CONFIG_DIR", "/tmp"));

  // Disposable is the right fallback, but landing on it silently is not. A profile that declares
  // a hook mechanism reports `detectsWaiting: true` on the session list, so the strip promises to
  // tell you when that agent needs you - while the fragment sits in a file the agent never reads
  // and the promise is never kept. A tab that is confidently wrong is the one output this design
  // refuses, so say so at boot rather than letting it be discovered by waiting for a prompt that
  // never lights up.
  if (
    process.env["AGENTDECK_AGENT_STATE_DIR"] === undefined &&
    process.env["CLAUDE_CONFIG_DIR"] === undefined
  ) {
    console.error(
      "agentdeck: neither AGENTDECK_AGENT_STATE_DIR nor CLAUDE_CONFIG_DIR is set, so any hook " +
        "settings fragment goes to /tmp where the agent will not read it. Agents configured with " +
        'waiting.via=hook will report "detects waiting" and never report waiting.',
    );
  }

  // Plan 001 states the Origin check as a property of the server, but the implementation is
  // present-but-off: src/http.ts and src/ws.ts both short-circuit when no expected origin is
  // configured, and AGENTDECK_ORIGIN is read here and set nowhere. Unset, every /api request and
  // every /ws upgrade is accepted from any Origin, so a page the phone visits can drive the
  // socket with a token it has. Say so at boot, the way the agent-state directory does, rather
  // than leaving a stated protection whose enable switch is invisible.
  if (process.env["AGENTDECK_ORIGIN"] === undefined) {
    console.error(
      "agentdeck: AGENTDECK_ORIGIN is not set, so the Origin check plan 001 describes is off. " +
        "Any page a browser visits can call /api and open /ws with a token it has. Set it to the " +
        "https://<host>.ts.net origin the phone loads.",
    );
  }

  // The cwd allowlist, which is also what the picker is served. One list with two jobs, so it has
  // exactly one source. AGENTDECK_MOUNTS is the name it was given when the list was also a set of
  // bind mounts; the list outlived the mounts.
  const mounts = env("AGENTDECK_MOUNTS", "")
    .split(":")
    .filter((entry) => entry !== "");
  const allowlist = new CwdAllowlist(mounts);

  let profilesRaw: unknown = {};
  const profilesPath = process.env["AGENTDECK_PROFILES"];
  if (profilesPath !== undefined) {
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

  // Once, here, and not once per session: one agent-state directory means one settings file,
  // shared by every session of that agent. What genuinely varies per session is the id and the
  // secret, and those go through the environment at spawn (plan 004).
  for (const profile of profiles.values()) {
    if (profile.waiting?.via !== "hook") continue;
    const settingsPath = isAbsolute(profile.waiting.settings)
      ? profile.waiting.settings
      : join(agentStateDir, profile.waiting.settings);
    try {
      const { changed } = installHookSettings(settingsPath, port);
      console.log(
        `agentdeck: ${profile.id} hooks ${changed ? "merged into" : "already present in"} ${settingsPath}`,
      );
    } catch (error) {
      // A fragment that will not merge disables the MECHANISM, not the profile. That agent drops
      // to working/idle/exited and stays startable - and the human's own edit stays as they left
      // it rather than being overwritten with ours.
      console.error(`agentdeck: ${profile.id} hook install failed for ${settingsPath}:`, error);
    }
  }

  const tmux = new Tmux({ socket });
  // Before anything asks tmux a question. Idempotent, so it costs nothing when a tmux server is
  // already up, and it is what lets the server start standalone - without it, /api/health reports
  // 503 at boot on any machine where nothing else started tmux first.
  await tmux.ensureServer();

  const registry = new Registry(tmux, profiles, allowlist);
  const hub = new Hub({ tmux, registry, socket });

  // Reaping at start rather than on a timer: "exited 1" in the strip is the answer to "did it
  // finish, or did I lose it", and expiring it after five minutes puts the question back.
  const reaped = await registry.reap();
  if (reaped.length > 0) console.log(`agentdeck: reaped ${String(reaped.length)} dead session(s)`);

  let token: string;
  try {
    token = loadToken(tokenFile);
  } catch (error) {
    console.error(`agentdeck: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const server = createServer(
    createHandler({
      onSessionsChanged: () => {
        void hub.sync();
      },
      registry,
      profiles,
      allowlist,
      token,
      version: VERSION,
      origin: process.env["AGENTDECK_ORIGIN"],
      probe: async () => await probeTmux(socket),
      streamFor: (id) => hub.streamFor(id),
    }),
  );

  const ws = attachWebSocketServer(server, {
    token,
    origin: process.env["AGENTDECK_ORIGIN"],
    streamFor: (id) => hub.streamFor(id),
    captureHistory: async (id) => await hub.captureHistory(id, HISTORY_LINES),
    sendInput: (id, data) => hub.sendInput(id, data),
    applyPaneSize: (id, cols, rows) => hub.applyPaneSize(id, cols, rows),
  });

  // Attach to whatever tmux already has before serving, so the first request sees real state
  // rather than an empty list that fills in a moment later.
  await hub.sync();
  const syncTimer = setInterval(() => void hub.sync(), SYNC_INTERVAL_MS);
  syncTimer.unref();

  // A port already in use is the most ordinary startup failure there is, and Node's default for
  // it is an unhandled 'error' event: a stack trace, a crash, and no sentence saying which port
  // or what to do. Errors are sentences here for the same reason they are on the wire.
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
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`agentdeck: listening on 127.0.0.1:${String(port)}`);
  console.log(
    `agentdeck: ${String(profiles.size)} agent profile(s), ${String(mounts.length)} mount(s)`,
  );

  const shutdown = (): void => {
    clearInterval(syncTimer);
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
