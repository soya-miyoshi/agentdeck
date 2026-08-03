import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { Registry } from "./registry.ts";
import { Tmux } from "./tmux.ts";
import { generateToken } from "./token.ts";

const run = promisify(execFile);

const VERSION = "0.0.0";
const HEALTH_TIMEOUT_MS = 3000;

/**
 * The token, generated on first run and stored 0600.
 *
 * The path is deliberately outside every bind mount. At the root of a mounted repository an agent
 * would meet it in an ordinary `ls -la` of its own working tree, and this token starts sessions in
 * any mounted repo, kills live ones, and attaches to every other agent's terminal. Same uid means
 * the mode hides nothing between the server and the agents - placement is the only control left,
 * and it hides rather than isolates (plan 005).
 */
const loadToken = (path: string): string => {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  } catch {
    // Absent is the first-run case, not an error.
  }
  const token = generateToken();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
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

  // The mount list, which is also the cwd allowlist and what the picker is served. One list with
  // three jobs, so it has exactly one source.
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

  const tmux = new Tmux({ socket });
  const registry = new Registry(tmux, profiles, allowlist);

  // Reaping at start rather than on a timer: "exited 1" in the strip is the answer to "did it
  // finish, or did I lose it", and expiring it after five minutes puts the question back.
  const reaped = await registry.reap();
  if (reaped.length > 0) console.log(`agentdeck: reaped ${String(reaped.length)} dead session(s)`);

  const token = loadToken(tokenFile);

  const server = createServer(
    createHandler({
      registry,
      profiles,
      allowlist,
      token,
      version: VERSION,
      origin: process.env["AGENTDECK_ORIGIN"],
      probe: async () => await probeTmux(socket),
    }),
  );

  // Loopback only. `tailscale serve` on the host is the single place where remote exposure is
  // decided, and binding the tailnet address here would make that two places.
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`agentdeck: listening on 127.0.0.1:${String(port)}`);
  console.log(
    `agentdeck: ${String(profiles.size)} agent profile(s), ${String(mounts.length)} mount(s)`,
  );

  const shutdown = (): void => {
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
