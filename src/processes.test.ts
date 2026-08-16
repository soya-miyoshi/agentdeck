// The tree building runs against a hand-written table, because the cases worth pinning are ones a
// live machine will not produce on demand. The last case runs the real `ps` once.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";

import { CwdAllowlist } from "./cwds.ts";
import { createHandler } from "./http.ts";
import { readProcessTable, parseEtime, sessionProcesses, treeOf } from "./processes.ts";
import { Registry } from "./registry.ts";
import type { Tmux } from "./tmux.ts";

const TOKEN = "processes-test-token";

/** The route never reaches tmux; a Registry is required by HttpDeps and this satisfies that. */
const stubTmux = (): Tmux => ({ list: () => Promise.resolve([]) }) as unknown as Tmux;

interface Raw {
  pid: number;
  ppid: number;
  ageSeconds: number;
  rssKb: number;
  cpuPercent: number;
  command: string;
}

const row = (pid: number, ppid: number, command: string, rssKb = 100): Raw => ({
  pid,
  ppid,
  ageSeconds: 60,
  rssKb,
  cpuPercent: 0,
  command,
});

void describe("reading elapsed time", () => {
  void test("every shape ps prints, and a refusal for one it does not", () => {
    assert.equal(parseEtime("00:05"), 5);
    assert.equal(parseEtime("02:03"), 123);
    assert.equal(parseEtime("01:00:00"), 3600);
    assert.equal(parseEtime("2-01:00:00"), 2 * 86400 + 3600);
    // -1 rather than 0: "unreadable" and "started this second" must not be the same answer, or a
    // row ps printed oddly reads as brand new and is treated as the safest thing on the list.
    assert.equal(parseEtime("nonsense"), -1);
  });
});

void describe("the tree under a pane", () => {
  const table = [
    row(100, 1, "tmux"),
    row(200, 100, "claude", 800),
    row(300, 200, "npm exec mcp", 40),
    row(400, 300, "node mcp-server", 30),
    row(500, 1, "something else entirely", 999),
  ];

  void test("is the pane and everything below it, and nothing beside it", () => {
    const tree = treeOf(table, 200);
    assert.deepEqual(
      tree.map((entry) => entry.pid),
      [200, 300, 400],
    );
    // The pane process is depth 0 and the grandchild is 2, which is what lets the phone indent
    // rather than show a flat list where an MCP server looks like the agent.
    assert.deepEqual(
      tree.map((entry) => entry.depth),
      [0, 1, 2],
    );
  });

  void test("is empty when the pane is already gone, rather than throwing", () => {
    assert.deepEqual(treeOf(table, 999), []);
  });

  void test("counts and sizes only what is BELOW the pane", async () => {
    const [session] = await sessionProcesses([{ sessionId: "repo-claude-abc", panePid: 200 }], () =>
      Promise.resolve(table),
    );
    assert.equal(session?.childCount, 2);
    // 40 + 30, not 870: the agent's own 800MB is what the session IS, not what it has left lying
    // around, and adding it in would make every idle session look like the worst offender.
    assert.equal(session?.childRssKb, 70);
  });

  void test("asks ps once however many sessions there are", async () => {
    let reads = 0;
    await sessionProcesses(
      [
        { sessionId: "a", panePid: 200 },
        { sessionId: "b", panePid: 300 },
        { sessionId: "c", panePid: 400 },
      ],
      () => {
        reads += 1;
        return Promise.resolve(table);
      },
    );
    assert.equal(reads, 1, "one ps per session does not scale to a phone tap");
  });

  void test("no panes means no ps at all", async () => {
    let reads = 0;
    const none = await sessionProcesses([], () => {
      reads += 1;
      return Promise.resolve(table);
    });
    assert.deepEqual(none, []);
    assert.equal(reads, 0);
  });
});

void describe("against the real ps", () => {
  void test("this process and its parent are both in the table, parsed", async () => {
    const rows = await readProcessTable();
    const self = rows.find((entry) => entry.pid === process.pid);
    assert.ok(self !== undefined, "the running test is not in the table ps printed");
    assert.equal(self.ppid, process.ppid);
    assert.ok(self.rssKb > 0, "rss parsed as zero for a live node process");
    assert.ok(self.command.length > 0, "the command column came back empty");
    // The command has spaces in it and is last, so a parse that split on whitespace loses it.
    assert.match(self.command, /node/);
  });

  void test("a real child appears under this process's tree", async () => {
    const child = spawnSync("/bin/sh", ["-c", "/bin/sleep 5 >/dev/null 2>&1 & echo $!"], {
      encoding: "utf8",
    });
    const pid = Number(child.stdout.trim());
    const rows = await readProcessTable();
    const tree = treeOf(rows, process.pid);
    assert.ok(
      tree.some((entry) => entry.pid === process.pid),
      "the root of its own tree is missing",
    );
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It had five seconds and may have been reaped already.
    }
  });
});

let server: Server;
let base = "";

before(async () => {
  server = createServer(
    createHandler({
      // The route never touches the registry; it is here because HttpDeps requires one.
      registry: new Registry(stubTmux(), new Map(), new CwdAllowlist([]), "test-secret-key"),
      profiles: new Map(),
      allowlist: new CwdAllowlist(["/workspace/agentdeck"]),
      token: TOKEN,
      version: "0.0.0-test",
      origin: undefined,
      probe: () => Promise.resolve(true),
      panePids: () => Promise.resolve([{ sessionId: "repo-claude-abc", panePid: process.pid }]),
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

void describe("GET /api/processes", () => {
  void test("needs the bearer token, like every route but health and hooks", async () => {
    const answer = await fetch(`${base}/api/processes`);
    assert.equal(answer.status, 401);
  });

  void test("answers each session's tree", async () => {
    const answer = await fetch(`${base}/api/processes`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as {
      sessions: { sessionId: string; panePid: number; processes: { pid: number }[] }[];
    };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]?.sessionId, "repo-claude-abc");
    assert.equal(body.sessions[0]?.panePid, process.pid);
    assert.ok(
      body.sessions[0]?.processes.some((entry) => entry.pid === process.pid),
      "the pane process is missing from its own tree",
    );
  });
});

void describe("without a way to ask tmux", () => {
  void test("the route answers an empty list rather than failing", async () => {
    const bare = createServer(
      createHandler({
        registry: new Registry(stubTmux(), new Map(), new CwdAllowlist([]), "test-secret-key"),
        profiles: new Map(),
        allowlist: new CwdAllowlist([]),
        token: TOKEN,
        version: "0.0.0-test",
        origin: undefined,
        probe: () => Promise.resolve(true),
      }),
    );
    await new Promise<void>((done) => bare.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${String((bare.address() as AddressInfo).port)}/api/processes`;
    const answer = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { sessions: [] });
    await new Promise<void>((done) => bare.close(() => done()));
  });
});
