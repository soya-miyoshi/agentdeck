// End-to-end against a REAL tmux and a REAL pty: create a session over HTTP, attach over the
// WebSocket, type into it, and check the output comes back. Nothing here is mocked.
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const PORT = process.env.PORT ?? "7799";
const base = `http://127.0.0.1:${PORT}`;
const token = readFileSync(process.env.TOKEN_FILE, "utf8").trim();
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const log = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

const health = await (await fetch(`${base}/api/health`)).json();
log("health", JSON.stringify(health));

const created = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ cwd: process.env.MOUNT, agent: "shell" }),
  })
).json();
if (created.error) throw new Error(`create failed: ${created.error}`);
const id = created.session.id;
log("created session", id);
log("warning", created.warning ?? "(none)");

// Give the hub's sync a beat to attach a pty to the new session.
await new Promise((r) => setTimeout(r, 1500));

const sessions = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
log("listed state", sessions.sessions.find((s) => s.id === id)?.state);

const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, token);
const frames = [];
socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
log("subprotocol echoed", socket.protocol === token ? "yes" : "NO - browser would close it");

socket.send(JSON.stringify({ t: "attach", sessionId: id, cols: 80, rows: 24 }));
await new Promise((r) => setTimeout(r, 800));
const snapshot = frames.find((f) => f.t === "snapshot");
log("snapshot", snapshot ? `epoch=${snapshot.epoch} seq=${snapshot.seq}` : "MISSING");

// Type something with a distinctive output, and wait for it to come back as ordinary output.
const marker = `agentdeck-e2e-${String(Date.now())}`;
socket.send(JSON.stringify({ t: "input", sessionId: id, data: `echo ${marker}\r` }));
const deadline = Date.now() + 6000;
let echoed = false;
while (Date.now() < deadline && !echoed) {
  await new Promise((r) => setTimeout(r, 200));
  echoed = frames.some((f) => f.t === "chunk" && f.data.includes(marker));
}
log("typed input echoed", echoed ? "yes" : "NO");

const chunks = frames.filter((f) => f.t === "chunk");
log("chunks received", String(chunks.length));
log("seq monotonic", String(chunks.every((c, i) => i === 0 || c.seq >= chunks[i - 1].seq)));
log("one epoch only", String(new Set(chunks.map((c) => c.epoch)).size <= 1));

// Resync from a stale epoch must produce a snapshot, never chunks.
frames.length = 0;
socket.send(JSON.stringify({ t: "resync", sessionId: id, haveEpoch: "stale", haveSeq: 1 }));
await new Promise((r) => setTimeout(r, 500));
log("stale epoch -> snapshot", frames.some((f) => f.t === "snapshot") ? "yes" : "NO");

const after = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
log("state after typing", after.sessions.find((s) => s.id === id)?.state);

socket.close();
const closed = await (
  await fetch(`${base}/api/sessions/${id}`, { method: "DELETE", headers: auth })
).json();
log("deleted", JSON.stringify(closed));

process.exit(echoed && snapshot ? 0 : 1);
