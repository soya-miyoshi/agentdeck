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
// Relative to this file rather than the working directory, so `pnpm start` from anywhere finds
// the same build, and fixed rather than configurable: one process serves one build.
const CLIENT_DIR = resolve(import.meta.dirname, "..", "dist", "client");

// How often the hub reconciles against tmux. This is what makes a session someone started by
// hand in a terminal appear in the strip, and what notices an agent that exited while nobody was
// looking. Cheap - one `list-sessions` - so it can afford to be frequent.
const SYNC_INTERVAL_MS = 2000;

/**
 * Where the bearer token lives unless `AGENTDECK_TOKEN_FILE` says otherwise.
 *
 * `~/.agentdeck/token`, decided 2026-08-07 and recorded in plan 005's superseded header. The old
 * `/var/lib/agentdeck/token` was reasoned from a boundary that no longer exists, and on a Mac no
 * ordinary user can create it - a plain `pnpm start` failed on the token before it ever reached
 * the port. This is a directory the user owns, that no session is pointed at, and
 * that exists on a clean host without a single environment variable being set.
 */
export const defaultTokenFile = (): string => join(homedir(), ".agentdeck", "token");

/**
 * Whether `tokenPath` sits inside a tree a session can be started in.
 *
 * Used for two files now: the bearer token, and the agent profiles file, which is the more direct
 * surface of the two - it decides the command every session runs, as the human.
 *
 * Plan 005 states this rule in prose in three places and until now nothing checked it. Same uid
 * means the 0600 mode buys nothing between the server and its agents, so placement is the whole
 * control: at or under the root of an allowlisted working tree, an agent's ordinary `ls -la` or
 * `grep -rn token .` ends with the token in a transcript on its way to a model API - and that
 * token starts sessions in every allowed repo, kills live ones, and attaches to every other
 * agent's terminal. A prefix test is right here even though `CwdAllowlist.allows` refuses one:
 * membership is the question there, containment is the question here.
 */
/**
 * The path a write to `p` would actually land on, symlinks followed.
 *
 * `resolve` normalises `.` and `..` and stops there, so a lexical comparison is blind to a symlink
 * - and `writeFileSync` is not: it follows. Measured before this was here: a symlink at
 * `~/.agentdeck/token` pointing into `dist/client` passed both refusals below, because its lexical
 * path is nowhere near either, and the first boot then created a real 0600 file inside the
 * publish root, served at a URL equal to its filename to anything on the tailnet with no token at
 * all. `src/static.ts` uses `realpath` for exactly this reason; these checks did not.
 *
 * The file itself usually does not exist yet - it is created on first run - so the DIRECTORY is
 * what gets resolved and the basename is rejoined. A missing directory resolves as far as it can.
 */
const wouldLandOn = (p: string, hops = 0): string => {
  const full = resolve(p);
  // The whole path, when everything on it exists. This is the case a planted symlink whose target
  // already exists takes.
  try {
    return realpathSync(full);
  } catch {
    // Falls through: something on the path does not exist yet, which is the ordinary first run.
  }
  // The LEAF may still be a symlink even when its target does not exist - which is exactly how the
  // bypass was planted, since the file the link points at is the one the first boot is about to
  // create. `realpath` of the directory cannot see that: the link is not in the directory's path.
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
    // wherever happened to be writable - including the one place it must not be. A sentence, like
    // EADDRINUSE below it.
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
  const tokenFile = env("AGENTDECK_TOKEN_FILE", defaultTokenFile());

  // Where a profile's relative `waiting.settings` lands: agentdeck's own agent-state directory,
  // named by AGENTDECK_AGENT_STATE_DIR rather than blindly the user's ~/.claude (plan 004).
  //
  // The fallback used to be CLAUDE_CONFIG_DIR, which is the operator's live Claude config. That
  // made an unset variable mean "rewrite, on every boot, the settings file every Claude Code
  // session on this machine reads, including the ones agentdeck has nothing to do with". A
  // directory of agentdeck's own is the only fallback that is agentdeck's to write.
  const agentStateDir = env(
    "AGENTDECK_AGENT_STATE_DIR",
    join(homedir(), ".agentdeck", "agent-state"),
  );

  // Landing on the fallback silently is the thing to avoid. A profile that declares a hook
  // mechanism reports `detectsWaiting: true` on the session list, so the strip promises to tell
  // you when that agent needs you - while the fragment sits in a directory the agent was never
  // pointed at and the promise is never kept. A tab that is confidently wrong is the one output
  // this design refuses, so say so at boot rather than letting it be discovered by waiting for a
  // prompt that never lights up.
  if (process.env["AGENTDECK_AGENT_STATE_DIR"] === undefined) {
    console.error(
      `agentdeck: AGENTDECK_AGENT_STATE_DIR is not set, so hook settings go to ${agentStateDir}. ` +
        `An agent only reads them if it is pointed there - for claude, CLAUDE_CONFIG_DIR in its ` +
        `profile's env. Until then, agents configured with waiting.via=hook report "detects ` +
        `waiting" and never report waiting.`,
    );
  }

  // Plan 001 states the Origin check as a property of the server, but the implementation is
  // present-but-off: src/http.ts and src/ws.ts both short-circuit when no expected origin is
  // configured. It is named in the README's Environment section now rather than only here, so
  // that a person can find it before meeting this line. Unset, every /api request and
  // every /ws upgrade is accepted from any Origin, so a page the phone visits can drive the
  // socket with a token it has. Say so at boot, the way the agent-state directory does, rather
  // than leaving a stated protection whose enable switch is invisible.
  // The tailnet is read here too (plan 006), so the value that variable should have is the real
  // ts.net origin rather than a placeholder.
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

  // The cwd allowlist, which is also what the picker is served. One list with two jobs, so it has
  // exactly one source. AGENTDECK_MOUNTS is the name it was given when the list was also a set of
  // bind mounts; the list outlived the mounts.
  // Images the phone sends into a session. Beside the token and the agent state rather than inside
  // any repository: a screenshot is not the work, and a session's tree is what a git remote
  // protects.
  const uploads = new UploadStore(
    env("AGENTDECK_UPLOAD_DIR", join(homedir(), ".agentdeck", "uploads")),
  );

  const paths = (name: string): string[] =>
    env(name, "")
      .split(":")
      .filter((entry) => entry !== "");

  // AGENTDECK_ROOTS is read on every request rather than captured here, so a repository cloned
  // while the server runs is startable without the restart that costs every running agent its
  // hook secret. AGENTDECK_MOUNTS stays for the directories that live outside any root.
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

  // Refuse to start rather than write the token somewhere an agent meets it. This is plan 005's
  // one surviving rule made executable: the token is never inside a tree a session is pointed at.
  // A refusal is the right shape because there is no degraded mode - starting anyway would serve
  // exactly the situation the rule exists to prevent, and would do it silently.
  // `dist/client` is the second dangerous location, and it is dangerous in a way the allowlist
  // does not describe: everything under it is served to anyone who can reach the port, with NO
  // bearer token, because the page has to load before a token exists. A token file placed there
  // is not merely readable by an agent - it is downloadable by any tailnet device with HTTP reach
  // and no shell at all, at a URL equal to its filename. And the allowlist check cannot catch it:
  // if this repo is not itself on AGENTDECK_MOUNTS, `tokenInsideAllowlist` says nothing and the
  // boot check passes.
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

  // A root counts as well as an allowlisted repository, and it has to: a root holds directories
  // that are not repositories yet, and a clone made tomorrow would swallow a file sitting there
  // with no boot left to notice it.
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
  // The same rule as the token file, for the file that is a more direct host-execution surface
  // than the token is: `command` and `args` go unmodified into `tmux new-session -- command args`
  // and run as the human. Inside a tree an agent is started in, an agent rewrites one profile to
  // `/bin/sh -c 'curl ...|sh'` and the next tap of that agent in the picker runs it - and no
  // prescribed review command looks at the file. A refusal, because there is no degraded mode.
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

  // Once, here, and not once per session: one agent-state directory means one settings file,
  // shared by every session of that agent. What genuinely varies per session is the id and the
  // secret, and those go through the environment at spawn (plan 004).
  for (const profile of profiles.values()) {
    if (profile.waiting?.via !== "hook") continue;
    // Always under the agent-state directory: `parseWaiting` refuses an absolute path or one that
    // climbs out, because this file is written at every boot and would otherwise be an arbitrary
    // JSON write aimed wherever a profiles file said.
    const settingsPath = join(agentStateDir, profile.waiting.settings);
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
  const hub = new Hub({
    tmux,
    registry,
    socket,
    // `state` is pushed rather than polled (plan 002), and the two sources of a state change - the
    // hub's inference and an agent's own hook - both go out through this one funnel. `ws` is
    // declared below, after the hub it announces for; nothing syncs before it exists.
    onState: (id, state, exitCode) => {
      ws.pushState(id, state, exitCode);
    },
  });

  // Reaping at start rather than on a timer: "exited 1" in the strip is the answer to "did it
  // finish, or did I lose it", and expiring it after five minutes puts the question back.
  // A tmux that will not answer at boot is not a reason to refuse to serve: the sync timer
  // reconciles again in a moment, and /api/health reports the truth in the meantime.
  try {
    const reaped = await registry.reap();
    if (reaped.length > 0)
      console.log(`agentdeck: reaped ${String(reaped.length)} dead session(s)`);
  } catch (error) {
    console.error("agentdeck: reap at boot failed, continuing:", error);
  }

  // Asked before `loadToken`, which is the call that creates the file. "First run" is the run that
  // issues the token, and it is the only run where a QR is worth printing: on every later boot the
  // devices already hold it, and reprinting a live credential into a terminal's scrollback on
  // every restart is how it ends up in a screen recording. Rotating is deleting the file, which
  // makes the next boot a first run again.
  // Asked the way `loadToken` asks it, not with `existsSync`. The two disagreed on one input and
  // it is the dangerous one: a file that exists but is empty - a truncated write, an interrupted
  // first boot, a `> ~/.agentdeck/token`, an editor that saved nothing, a restore that produced a
  // stub. `loadToken` treats that as a first run and mints a NEW token, silently signing out every
  // device holding the old one, while `existsSync` said "not a first run" so nothing was printed:
  // no QR, and not even the line naming the file. A rotation nobody asked for and nobody was told
  // about. One question, one answer.
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
          // `POST /api/hooks/:id` is the one route not behind the user's token - it is
          // authenticated by the per-session secret, which `Registry.secretMatches` checks against
          // `#meta` alone. A `#meta` entry outlives the session's membership of `Registry.list()`:
          // a session recreated by hand at a path off the allowlist is dropped by `list()` on every
          // call, so neither `close()` nor `reap()` ever removes its metadata and its secret keeps
          // authenticating forever. Without this check that id could put a state frame for an
          // off-allowlist session onto every socket, which makes this a second place the cwd
          // boundary is decided - the thing `Registry.list` is documented as being the only one of.
          //
          // The hub holds a stream only for what `sync()` adopted through that filtered list, and a
          // hook POST comes from a running agent, so "attached" is exactly the right set.
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

  // Attach to whatever tmux already has before serving, so the first request sees real state
  // rather than an empty list that fills in a moment later.
  // A failed poll is a stale session list for one tick. It must never be an exited process:
  // nothing supervises this one (m0/supervisor-crash-test), so a crash costs every attached
  // phone its socket until a human with shell access restarts it by hand.
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

  // Collecting what sessions leave behind, for as long as this process is up. The deck is the gate
  // the operator asked for - no launchd job, and nothing reaping on a Mac where agentdeck is not
  // running. Announced rather than silent: it kills processes, so a person reading the boot output
  // has to be able to see that it is on and how to turn it off.
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
