// The scheduling half is driven directly; the last case boots the REAL server against a real orphan,
// because what breaks silently is the contract with the script and no stub can see it.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startReaping, type ReapOutcome } from "./reap-schedule.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(repoRoot, "src", "server.ts");

const temps: string[] = [];
const strays: number[] = [];
const children: ChildProcess[] = [];

const temp = (name: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  temps.push(dir);
  return dir;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

const tmuxSocket = `agentdeck-sched-${String(process.pid)}`;

after(() => {
  for (const child of children) child.kill("SIGKILL");
  // The booted servers start a tmux on this socket with `exit-empty off`, which outlives every
  // process killed above. Caught by toolchain.test.ts's guard, which this file had just broken.
  spawnSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" });
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped, which is the point of the last case.
    }
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

void describe("the schedule", () => {
  void test("runs the reaper repeatedly until it is stopped", async () => {
    let passes = 0;
    const stop = startReaping(
      20,
      () => {
        passes += 1;
        return Promise.resolve({ ok: true, summary: "" });
      },
      () => {},
    );
    await sleep(150);
    stop();
    const afterStop = passes;
    assert.ok(passes >= 3, `only ${String(passes)} passes in 150ms of a 20ms interval`);
    await sleep(100);
    assert.equal(passes, afterStop, "it kept running after being stopped");
  });

  // A pass that outlives its interval must not have a second one started underneath it: both would
  // signal the same pids, and the second's "SURVIVED" would be the first's grace period.
  void test("never runs two passes at once", async () => {
    let started = 0;
    let release = (): void => {};
    const stop = startReaping(
      10,
      () => {
        started += 1;
        return new Promise<ReapOutcome>((done) => {
          release = () => {
            done({ ok: true, summary: "" });
          };
        });
      },
      () => {},
    );
    await sleep(120);
    assert.equal(started, 1, `${String(started)} passes overlapped`);
    release();
    await sleep(60);
    stop();
    assert.ok(started > 1, "it never resumed after the slow pass finished");
  });

  void test("says nothing on a pass that collected nothing, and speaks when it collects", async () => {
    const said: string[] = [];
    const quiet = startReaping(
      10,
      () => Promise.resolve({ ok: true, summary: "" }),
      (line) => said.push(line),
    );
    await sleep(60);
    quiet();
    // `assert.deepEqual(said, [])` would narrow `said` to never[] for the rest of the function and
    // the next push stops compiling, which `node --test` never notices because it runs fine.
    assert.equal(said.length, 0, `a pass that reaped nothing logged: ${said.join(" / ")}`);

    const loud = startReaping(
      10,
      () => Promise.resolve({ ok: true, summary: "reaped 1" }),
      (line) => said.push(line),
    );
    await sleep(60);
    loud();
    assert.ok(said.length > 0, "a pass that reaped something logged nothing");
    assert.match(said[0] ?? "", /reaped 1/);
  });

  void test("a failing pass is logged rather than left to reject", async () => {
    const said: string[] = [];
    const stop = startReaping(
      10,
      () => Promise.reject(new Error("boom")),
      (line) => said.push(line),
    );
    await sleep(60);
    stop();
    assert.ok(
      said.some((line) => line.includes("boom")),
      `the failure never reached the log: ${said.join(" / ")}`,
    );
  });
});

const freePort = async (): Promise<number> =>
  await new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        done(found);
      });
    });
  });

/** An orphan under `cwd`: ppid 1, no controlling terminal, which is the shape the reaper collects. */
const orphan = (cwd: string): number => {
  const printed = execFileSync(
    "/bin/sh",
    ["-c", `cd ${cwd} && exec /bin/sleep 100000 >/dev/null 2>&1 & echo $!`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const pid = Number(printed.trim());
  strays.push(pid);
  for (let i = 0; i < 100; i += 1) {
    const ppid = spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    if (Number((ppid.stdout || "0").trim()) === 1) break;
    spawnSync("/bin/sleep", ["0.05"]);
  }
  // `ps` reports elapsed time in whole seconds, so nothing is old enough to match any bound above
  // zero for its first second.
  spawnSync("/bin/sleep", ["1.2"]);
  return pid;
};

/** The real server, against a temp HOME and a root of its own. */
const boot = async (
  extra: Record<string, string>,
): Promise<{ out: () => string; port: number }> => {
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: temp("agentdeck-sched-home-"),
      TERM: "dumb",
      LC_ALL: "en_US.UTF-8",
      TMUX_SOCKET: tmuxSocket,
      AGENTDECK_PORT: String(port),
      // Its own namespace, so a pass this server runs cannot reach the machine's real sockets.
      AGENTDECK_REAP_SOCKET_PREFIX: `schedtest-${String(process.pid)}-`,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (text += chunk));
  child.stderr.on("data", (chunk: string) => (text += chunk));
  for (let i = 0; i < 200 && !text.includes("listening on"); i += 1) await sleep(100);
  assert.ok(text.includes("listening on"), `the server never listened\n${text}`);
  return { out: () => text, port };
};

void describe("the deck reaping while it runs", () => {
  void test("says on boot that it is on, and then actually collects an orphan", async () => {
    const root = temp("agentdeck-sched-root-");
    const pid = orphan(root);
    const server = await boot({
      AGENTDECK_ROOTS: root,
      AGENTDECK_REAP_INTERVAL_MS: "700",
      AGENTDECK_REAP_MIN_AGE_MS: "1",
      AGENTDECK_REAP_STOP_GRACE_MS: "500",
    });

    // Loud on purpose: this kills processes nobody personally decided about, so a person reading
    // the boot output has to be able to see that it is on.
    assert.match(server.out(), /collecting abandoned processes/i, server.out());

    // Waited for the LOG rather than the pid: the process dies before the reaper exits and the server
    // parses its report, so watching the pid raced the line into existence.
    for (let i = 0; i < 150 && !/reaped .*orphan tree/i.test(server.out()); i += 1)
      await sleep(100);
    assert.match(server.out(), /reaped .*orphan tree/i, server.out());
    assert.ok(!alive(pid), `it reported reaping but pid ${String(pid)} is alive\n${server.out()}`);
  });

  void test("an interval of 0 turns it off, and the orphan is left alone", async () => {
    const root = temp("agentdeck-sched-off-root-");
    const pid = orphan(root);
    const server = await boot({
      AGENTDECK_ROOTS: root,
      AGENTDECK_REAP_INTERVAL_MS: "0",
      AGENTDECK_REAP_MIN_AGE_MS: "1",
    });
    assert.doesNotMatch(server.out(), /collecting abandoned processes/i, server.out());
    await sleep(2000);
    assert.ok(alive(pid), `it reaped with the interval set to 0\n${server.out()}`);
  });
});
