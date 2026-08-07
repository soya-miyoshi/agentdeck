// A failed poll must be a stale session list for one tick, never an exited process.
//
// Two ways the 2s sync tick used to kill the whole server, both reproduced here against a real
// spawned `node src/server.ts` rather than an in-process handler, because the event under test is
// the process staying alive:
//
//   - a tmux session whose `#{session_path}` contains a newline. `#{session_path}` is last in the
//     `list-sessions -F` format, so such a session splits into a parseable record plus a
//     separator-less remainder, and `Tmux.list()` refused the ENTIRE list on it. Anything running
//     as this user can create one - including any agent agentdeck starts - so one `mkdir` took
//     every session's stream and every tab with it.
//   - any other tmux failure on the timer (`lost server`, EMFILE spawning the client). `void
//     hub.sync()` discarded the rejection, so it surfaced as ERR_UNHANDLED_REJECTION and exited.
//
// Nothing supervises this process (m0/supervisor-crash-test), so either one costs every attached
// phone its socket until a human with shell access restarts it by hand.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("server.ts", import.meta.url));
const socket = `agentdeck-sync-${String(process.pid)}`;
const SYNC_INTERVAL_MS = 2000;

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-sync-home-");
const work = temp("agentdeck-sync-work-");
const conf = temp("agentdeck-sync-conf-");
// A path with a newline in it, which is a legal path and the whole point of the first test.
const rogue = join(work, "ro\ngue");

const realTmux = execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();

// A tmux on PATH that is the real one, except that while the marker file exists every
// `list-sessions` fails the way a server killed out from under an in-flight client does. `lost
// server` is deliberately not one of the phrases `isEmptyTmux` forgives.
const marker = join(conf, "break-list-sessions");
const shimDir = join(conf, "bin");
execFileSync("/bin/mkdir", ["-p", shimDir]);
const shim = join(shimDir, "tmux");
writeFileSync(
  shim,
  `#!/bin/sh
if [ -e ${JSON.stringify(marker)} ]; then
  for arg in "$@"; do
    if [ "$arg" = "list-sessions" ]; then
      echo "lost server" >&2
      exit 1
    fi
  done
fi
exec ${JSON.stringify(realTmux)} "$@"
`,
);
chmodSync(shim, 0o755);

const profiles = join(conf, "agents.json");
writeFileSync(
  profiles,
  JSON.stringify({ shell: { command: "/bin/sh", args: ["-c", "exec sleep 100000"] } }),
);

let port = 0;
let token = "";
let child: ChildProcess | undefined;

const freePort = async (): Promise<number> =>
  await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(found);
      });
    });
  });

const start = async (): Promise<ChildProcess> => {
  const started = spawn(process.execPath, [serverPath], {
    env: {
      // The shim first, so every tmux the server runs goes through it.
      PATH: [shimDir, dirname(realTmux), "/usr/bin", "/bin"].join(delimiter),
      TMUX_SOCKET: socket,
      HOME: home,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: work,
      AGENTDECK_PROFILES: profiles,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  started.stdout.setEncoding("utf8");
  started.stderr.setEncoding("utf8");
  started.stderr.on("data", (chunk: string) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the server did not listen within 20s\n${stdout}\n${stderr}`));
    }, 20_000);
    timer.unref();
    started.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    started.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited ${String(code)} instead of listening\n${stderr}`));
    });
  });
  child = started;
  return started;
};

const api = async (path: string): Promise<Response> =>
  await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

before(async () => {
  port = await freePort();
});

after(() => {
  if (child !== undefined) child.kill("SIGKILL");
  rmSync(marker, { force: true });
  try {
    execFileSync(realTmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone: the desired end state.
  }
  for (const dir of [home, work, conf]) rmSync(dir, { recursive: true, force: true });
});

void describe("a sync that fails does not take the server with it", () => {
  void test("a session whose path contains a newline costs at most that session", async () => {
    const server = await start();
    token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
    assert.equal((await api("/api/sessions")).status, 200);

    // Exactly what any process running as this user can do, on the socket agentdeck shares.
    execFileSync("/bin/mkdir", ["-p", rogue]);
    execFileSync(realTmux, ["-L", socket, "new-session", "-d", "-c", rogue, "--", "sleep", "300"]);

    // Two full sync ticks, so a `list()` that refuses the whole output has fired more than once.
    await wait(SYNC_INTERVAL_MS * 2 + 500);

    assert.equal(server.exitCode, null, "the server exited over one session's odd working dir");
    assert.equal(
      (await api("/api/sessions")).status,
      200,
      "GET /api/sessions stopped answering because another session had a newline in its path",
    );
  });

  void test("a boot with that session already present still reaches listen", async () => {
    // The same failure at `registry.reap()`, before the port is ever bound: the rogue session is
    // still up from the test above, so this start is the crash-before-listen case.
    if (child !== undefined) child.kill("SIGKILL");
    child = undefined;
    await start();
    assert.equal((await api("/api/sessions")).status, 200);
  });

  void test("a tmux failure on the timer degrades one poll, it does not exit the process", async () => {
    const server = child;
    assert.ok(server !== undefined);

    writeFileSync(marker, "");
    await wait(SYNC_INTERVAL_MS * 2 + 500);
    assert.equal(server.exitCode, null, "an unhandled rejection from the sync timer killed it");

    rmSync(marker, { force: true });
    await wait(SYNC_INTERVAL_MS + 500);
    assert.ok(existsSync(join(home, ".agentdeck", "token")));
    assert.equal(
      (await api("/api/sessions")).status,
      200,
      "the server did not recover once tmux answered again",
    );
  });
});
