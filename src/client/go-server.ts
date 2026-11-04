// For tests only: the Go server built from this checkout and started on a free port, so a client
// test asserts against the real thing rather than a stand-in for it.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface GoServer {
  base: string;
  token: string;
  stop: () => Promise<void>;
}

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

/** Build and start the server with `env` on top of an isolated home, token and tmux socket. */
export const startGoServer = async (env: Record<string, string> = {}): Promise<GoServer> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentdeck-goserver-")));
  const binary = join(dir, "agentdeck");
  execFileSync("go", ["build", "-o", binary, "."], { cwd: join(repoRoot, "server-go") });
  const port = await freePort();
  const socket = `agentdeck-e2e-go-${String(process.pid)}-${String(port)}`;
  const tokenFile = join(dir, "token");
  const child: ChildProcess = spawn(binary, [], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: dir,
      TERM: "xterm-256color",
      LC_ALL: "en_US.UTF-8",
      TMUX_SOCKET: socket,
      AGENTDECK_REPO: repoRoot,
      AGENTDECK_PORT: String(port),
      AGENTDECK_TOKEN_FILE: tokenFile,
      AGENTDECK_AGENT_STATE_DIR: join(dir, "agent-state"),
      AGENTDECK_REAP_INTERVAL_MS: "0",
      AGENTDECK_TAILSCALE: join(dir, "no-tailscale"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the Go server did not listen within 20s\n${output}`));
    }, 20_000);
    const read = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the Go server exited ${String(code)} before listening\n${output}`));
    });
  });
  return {
    base: `http://127.0.0.1:${String(port)}`,
    token: readFileSync(tokenFile, "utf8").trim(),
    stop: async () => {
      await new Promise<void>((done) => {
        if (child.exitCode !== null) {
          done();
          return;
        }
        child.once("exit", () => {
          done();
        });
        child.kill("SIGTERM");
      });
      // The tmux server this one started, and its socket file, go with it.
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
      rmSync(join(`/private/tmp/tmux-${String(process.getuid?.() ?? 0)}`, socket), { force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
