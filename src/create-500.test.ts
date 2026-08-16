// `POST /api/sessions` answered 500 on a real run and left the agent running: tmux rewrites U+001F to
// `_` for a non-UTF-8 client, so `list()` dropped the session just created. Only the REAL binary does.

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseProfiles } from "./agent-profiles.ts";
import { CwdAllowlist } from "./cwds.ts";
import { Registry } from "./registry.ts";
import { baseEnv, Tmux } from "./tmux.ts";

const run = promisify(execFile);
const serverPath = fileURLToPath(new URL("server.ts", import.meta.url));
const socket = `agentdeck-create500-${String(process.pid)}`;

const temp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const home = temp("agentdeck-c5-home-");
const work = temp("agentdeck-c5-work-");
const conf = temp("agentdeck-c5-conf-");

const profiles = join(conf, "agents.json");
writeFileSync(
  profiles,
  JSON.stringify({ sh: { command: "/bin/sh", args: ["-c", "exec sleep 100000"], name: "Shell" } }),
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

/** Every session name tmux currently holds on our socket, read outside the code under test. */
const sessionNames = (): string[] => {
  try {
    return execFileSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "en_US.UTF-8" },
    })
      .trim()
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    // No server, or no sessions. Both mean nothing is held.
    return [];
  }
};

before(async () => {
  port = await freePort();
  // THE REPRODUCTION: no LANG, no LC_ALL, no LC_CTYPE. Nothing else about this environment is
  // unusual, and that is the point - it is what `env -i` and launchd give a process.
  const started = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      TERM: "xterm-256color",
      TMUX_SOCKET: socket,
      AGENTDECK_PORT: String(port),
      AGENTDECK_MOUNTS: work,
      AGENTDECK_PROFILES: profiles,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = started;
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
  token = readFileSync(join(home, ".agentdeck", "token"), "utf8").trim();
});

after(() => {
  if (child !== undefined) child.kill("SIGKILL");
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone: the desired end state.
  }
  for (const dir of [home, work, conf]) rmSync(dir, { recursive: true, force: true });
});

void describe("POST /api/sessions against the real tmux, from a server with no locale", () => {
  void test("answers 201 with the session it created", async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd: work, agent: "sh" }),
    });
    const body = (await response.clone().text()).trim();
    assert.equal(response.status, 201, `create failed: ${body}`);

    const created = (await response.json()) as { session: { id: string; cwd: string } };
    assert.equal(created.session.cwd, work);
    const held = sessionNames();
    assert.ok(
      held.includes(created.session.id),
      `tmux does not hold the session the 201 named; it holds ${held.join(", ")}`,
    );

    // And the same session is listed afterwards, which is the assertion the parse bug broke: it
    // was created, it was running, and every route claimed there was nothing there.
    const listed = (await (
      await fetch(`http://127.0.0.1:${String(port)}/api/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { sessions: { id: string }[] };
    assert.deepEqual(
      listed.sessions.map((s) => s.id),
      [created.session.id],
    );
  });
});

void describe("a create that fails for any other reason leaves no orphan", () => {
  void test("the session tmux made is killed again when the call cannot finish", async () => {
    // The real binary doing a real create, with the ONE call after it made to fail: not the parse
    // bug, which is fixed at its cause, but whatever comes next.
    const orphanSocket = `${socket}-orphan`;
    let creates = 0;
    const tmux = new Tmux({
      socket: orphanSocket,
      exec: async (args, extra) => {
        if (args.includes("new-session")) creates++;
        if (args[0] === "list-sessions" && creates > 0) {
          throw new Error("tmux is not answering, as far as this call is concerned");
        }
        return await run("tmux", ["-L", orphanSocket, ...args], {
          encoding: "utf8",
          env: { ...baseEnv(), ...extra },
        });
      },
    });
    const registry = new Registry(
      tmux,
      parseProfiles(JSON.parse(readFileSync(profiles, "utf8"))).profiles,
      new CwdAllowlist([work]),
      "test-secret-key",
    );
    await tmux.ensureServer();

    await assert.rejects(async () => await registry.create(work, "sh"));

    const held = execFileSync("tmux", [
      "-L",
      orphanSocket,
      "list-sessions",
      "-F",
      "#{session_name}",
    ])
      .toString()
      .trim();
    execFileSync("tmux", ["-L", orphanSocket, "kill-server"], { stdio: "ignore" });
    assert.equal(held, "", `the failed create left ${held} running on the socket`);
  });
});
