// Liveness, not correctness (plan 006).
//
// A health check that depends on a coding agent behaving will produce false positives,
// and a false positive here costs a restart nobody needed - so this touches no agent and
// no agent's files, and both halves are hard-timed so a wedged tmux or a wedged event
// loop fails the check rather than hanging it.
//
// Run on the Mac, by hand or by the launchd watchdog at M4 (plan 006). It is the whole
// check: nothing schedules it, and nothing acts on it, until that watchdog exists.
//
// Two halves, both required, because they fail apart from each other. tmux can be gone
// while the server still accepts sockets, and the server can be wedged - the event loop
// blocked, the socket still accepted - while tmux is perfectly healthy. `/api/health`
// answers from the same event loop that serves the app, so a reply is proof the loop is
// turning, which is the half that catches the wedge.

import { execFile } from "node:child_process";

const SOCKET = process.env.TMUX_SOCKET ?? "agentdeck";
const PORT = process.env.AGENTDECK_PORT ?? "7777";
const TIMEOUT_MS = 3000;

const unhealthy = (message) => {
  console.error(`unhealthy: ${message}`);
  process.exit(1);
};

const checkTmux = () =>
  new Promise((resolve) => {
    execFile(
      "tmux",
      ["-L", SOCKET, "list-sessions", "-F", "#{session_name}"],
      { timeout: TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) return resolve(null);

        // tmux exits non-zero for two very different things, and only one of them is a
        // failure. "no sessions" is a healthy server with nothing running in it yet,
        // which is the normal state right after boot. "no server running" means the
        // server is gone and took every session with it. Exit code cannot separate them;
        // the text can.
        const text = `${stderr}${error.message}`;

        if (/no sessions/i.test(text)) return resolve(null);
        if (/no server running/i.test(text)) return resolve("tmux server is not running");
        resolve(`tmux unreachable (${error.message.trim()})`);
      },
    );
  });

// A wedged event loop does not refuse the connection, it just never answers, so the
// timeout is the half of this check that catches the failure it exists for. The timer is
// unref'd rather than cleared: the process exits on either outcome, so an unref'd handle
// is all the cleanup there is to do.
const timeout = new Promise((resolve) => {
  setTimeout(() => resolve("timeout"), TIMEOUT_MS).unref();
});

const checkHttp = async () => {
  let response;
  try {
    response = await Promise.race([fetch(`http://127.0.0.1:${PORT}/api/health`), timeout]);
  } catch (error) {
    // Connection refused is the server being down. Same verdict as a timeout, different
    // sentence, and the sentence is the point of running this by hand.
    return `no answer from 127.0.0.1:${PORT}/api/health (${String(error)})`;
  }
  if (response === "timeout") {
    return `127.0.0.1:${PORT}/api/health did not answer within ${String(TIMEOUT_MS)}ms`;
  }
  if (!response.ok) return `/api/health returned ${String(response.status)}`;

  // Unauthenticated by design (plan 001), so there is a body to read and it is worth
  // reading: a 200 carrying `ok: false` is the server reporting its own tmux probe
  // failed, which is a different sentence from the socket not answering.
  const body = await response.json().catch(() => null);
  if (body?.ok !== true) return "/api/health answered but does not report ok";
  return null;
};

const failure = (await checkTmux()) ?? (await checkHttp());
if (failure !== null) unhealthy(failure);
process.exit(0);
