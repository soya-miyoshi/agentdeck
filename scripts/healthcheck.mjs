// Liveness, not correctness (plan 006).
//
// A health check that depends on a coding agent behaving will produce false positives,
// and a false positive here costs sessions — so this touches no agent, no mount and no
// network, and it is hard-timed so a wedged tmux fails the check rather than hanging it.
//
// TODO(M1): add the other half. `GET /api/health` must prove the event loop is turning,
// not merely that a socket accepts, so once the server exists this script also hits
// http://127.0.0.1:${AGENTDECK_PORT}/api/health and requires both to pass. Until then a
// green check means "tmux is reachable", which is less than the finished check claims
// and more than nothing.

import { execFile } from "node:child_process";

const SOCKET = process.env.TMUX_SOCKET ?? "agentdeck";
const TIMEOUT_MS = 3000;

execFile(
  "tmux",
  ["-L", SOCKET, "list-sessions", "-F", "#{session_name}"],
  { timeout: TIMEOUT_MS },
  (error, _stdout, stderr) => {
    if (!error) process.exit(0);

    // tmux exits non-zero for two very different things, and only one of them is a
    // failure. "no sessions" is a healthy server with nothing running in it yet, which
    // is the normal state right after boot. "no server running" means the server is gone
    // and took every session with it. Exit code cannot separate them; the text can.
    const text = `${stderr}${error.message}`;

    if (/no sessions/i.test(text)) process.exit(0);

    if (/no server running/i.test(text)) {
      console.error("unhealthy: tmux server is not running");
      process.exit(1);
    }

    console.error(`unhealthy: tmux unreachable (${error.message.trim()})`);
    process.exit(1);
  },
);
