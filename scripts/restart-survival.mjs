// M1's acceptance criterion, and the reason tmux is a dependency at all: create a session,
// restart the SERVER, list again, and find the same session with the same id still running.
//
// This is the property that makes a laptop lid a non-event. It is also the one that silently
// does not hold if session ids stop being a pure function of (path, agent), because then a
// restarted server cannot recognise what it finds in tmux and has to orphan it.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT ?? "7801";
const base = `http://127.0.0.1:${PORT}`;
const tokenFile = process.env.TOKEN_FILE;
const env = { ...process.env, AGENTDECK_PORT: PORT };

const log = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

const startServer = () => {
  const child = spawn("node", ["src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => {
    const text = String(d);
    if (text.includes("Error")) console.error("server stderr:", text.trim());
  });
  return child;
};

const waitForHealth = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const auth = () => ({
  authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`,
  "content-type": "application/json",
});

const list = async () =>
  (await (await fetch(`${base}/api/sessions`, { headers: auth() })).json()).sessions;

let server = startServer();
if (!(await waitForHealth())) throw new Error("first server never became healthy");

const created = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ cwd: process.env.MOUNT, agent: "shell" }),
  })
).json();
if (created.error) throw new Error(`create failed: ${created.error}`);
const id = created.session.id;
log("created", id);

await new Promise((r) => setTimeout(r, 1500));
const before = await list();
log("before restart", `${String(before.length)} session(s), state=${before[0]?.state}`);

// Kill the server the way a crash would, not the way a shutdown would.
server.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 1000));
log("server killed", "SIGKILL");

server = startServer();
if (!(await waitForHealth())) throw new Error("second server never became healthy");
await new Promise((r) => setTimeout(r, 1500));

const after = await list();
const survivor = after.find((s) => s.id === id);
log("after restart", `${String(after.length)} session(s)`);
log("same id present", survivor ? "yes" : "NO");
log("still alive", survivor && survivor.state !== "exited" ? "yes" : "NO");

// The stream must work again too - a session that lists but cannot be attached to is only half
// recovered, and the epoch is new so the client is owed a snapshot rather than chunks.
const { WebSocket } = await import("ws");
const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, readFileSync(tokenFile, "utf8").trim());
const frames = [];
socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
socket.send(JSON.stringify({ t: "attach", sessionId: id, cols: 80, rows: 24 }));
await new Promise((r) => setTimeout(r, 1000));
const snapshot = frames.find((f) => f.t === "snapshot");
log("reattached and painted", snapshot ? `yes, epoch=${snapshot.epoch}` : "NO");

socket.close();
await fetch(`${base}/api/sessions/${id}`, { method: "DELETE", headers: auth() });
server.kill("SIGTERM");

const passed = Boolean(survivor) && survivor.state !== "exited" && Boolean(snapshot);
log("RESULT", passed ? "PASS" : "FAIL");
process.exit(passed ? 0 : 1);
