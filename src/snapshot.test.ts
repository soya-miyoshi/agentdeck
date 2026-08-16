// A client attaching to a session idle since before the attach sees scrollback and then a CORRECT LIVE
// SCREEN. Everything at issue is tmux's own behaviour, so the whole production chain runs here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { parseProfiles } from "./agent-profiles.ts";
import { buildSnapshot } from "./attach.ts";
import { CwdAllowlist } from "./cwds.ts";
import { Hub } from "./hub.ts";
import { Registry } from "./registry.ts";
import type { SessionStream } from "./stream.ts";
import { Tmux } from "./tmux.ts";

const socket = `agentdeck-snapshot-${String(process.pid)}`;
const work = realpathSync(mkdtempSync(join(tmpdir(), "agentdeck-snapshot-")));

// Three panes, because the three cases cannot share one: a session id is a pure function of
// (cwd, agent), and each of these has to be its own pane with its own history.
const SCRIPTS = {
  // Idle SINCE BEFORE THE ATTACH: it prints everything in the first moments and then sits, so most
  // lines have scrolled off and the live screen is nowhere in a stream nobody was reading.
  idle: `i=1; while [ $i -le 200 ]; do echo scrollback-line-$i; i=$((i+1)); done; printf 'LIVE-SCREEN-MARKER'; exec sleep 100000`,
  // Busy AFTER the attach, so the ring buffer really does hold hundreds of lines that have since
  // scrolled off the screen. That is the case the old `data` got wrong twice over.
  burst: `sleep 2; i=1; while [ $i -le 400 ]; do echo burst-line-$i; i=$((i+1)); done; printf 'BURST-TAIL-MARKER'; exec sleep 100000`,
  // A full-screen TUI: normal output first, so there IS scrollback for a capture to find, then
  // the alternate screen. `capture-pane` after this returns the TUI's frame, not the lines above.
  tui: `echo before-the-tui-started; printf '\\033[?1049h'; printf 'TUI-FRAME-MARKER'; exec sleep 100000`,
} as const;

const { profiles } = parseProfiles({
  idle: { command: "/bin/sh", args: ["-c", SCRIPTS.idle] },
  burst: { command: "/bin/sh", args: ["-c", SCRIPTS.burst] },
  tui: { command: "/bin/sh", args: ["-c", SCRIPTS.tui] },
});

const tmux = new Tmux({ socket });
const registry = new Registry(tmux, profiles, new CwdAllowlist([work]), "test-secret-key");
const hub = new Hub({ tmux, registry, socket });

/** Wait until the stream has stopped moving, which is the only "the pane has settled" there is. */
const quiet = async (stream: SessionStream, forMs = 300, capMs = 15_000): Promise<void> => {
  const deadline = Date.now() + capMs;
  let last = -1;
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (stream.buffer.headSeq !== last) {
      last = stream.buffer.headSeq;
      since = Date.now();
    } else if (Date.now() - since >= forMs && last > 0) {
      return;
    }
  }
};

/** Wait for something the pane has not printed yet, so a test cannot race its own premise. */
const waitFor = async (stream: SessionStream, marker: string, capMs = 20_000): Promise<void> => {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (stream.buffer.snapshot().toString("utf8").includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`the pane never printed ${marker}`);
};

/** The snapshot the server would send, from the same sources `src/server.ts` wires up. */
const coldSnapshot = async (id: string, stream: SessionStream) =>
  await buildSnapshot({
    buffer: stream.buffer,
    captureHistory: async () => await hub.captureHistory(id, 2000),
    alternateScreen: async () => await hub.isAlternateScreen(id),
    repaint: async () => await hub.repaint(id),
  });

const streamOf = (id: string): SessionStream => {
  const stream = hub.streamFor(id);
  assert.ok(stream, `the hub never attached to ${id}`);
  return stream;
};

before(async () => {
  await tmux.ensureServer();
});

after(() => {
  hub.disposeAll();
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone: the desired end state.
  }
  rmSync(work, { recursive: true, force: true });
});

void describe("a cold snapshot of a real session idle since before the attach", () => {
  void test("history holds the lines that scrolled off, and data is the live screen", async () => {
    const { session } = await registry.create(work, "idle");
    // The pane prints and goes quiet with NOBODY reading its PTY. This second is the whole
    // premise: the live screen exists only in tmux, and no byte of it is in any buffer here.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await hub.sync();
    const stream = streamOf(session.id);
    await quiet(stream);

    const snapshot = await coldSnapshot(session.id, stream);

    // On THIS pane the old `data` would also have looked right, since the buffer holds only the
    // attach paint. The next test is what tells the two sources apart.
    assert.ok(snapshot.history, "a session with 200 lines of output has scrollback");
    assert.match(snapshot.history, /scrollback-line-1$/m, "the earliest line is missing");
    assert.match(snapshot.history, /scrollback-line-100$/m);
    // Observed rather than assumed: `-E -1` ends at the last line that has ALREADY scrolled off, so
    // the two halves of the frame divide the pane instead of overlapping.
    assert.doesNotMatch(
      snapshot.history,
      /LIVE-SCREEN-MARKER/,
      "history reached into the visible screen, which data is about to paint",
    );

    assert.match(snapshot.data, /LIVE-SCREEN-MARKER/, "the live screen is not in the snapshot");
    // A repaint is terminal state, not lines: cursor positioning is the visible half of the
    // difference between `refresh-client -R` and a `capture-pane` of the same pane.
    assert.ok(snapshot.data.includes("\u001b"), "a repaint carries escapes; a line dump need not");

    // The seq is the one the repaint reflects, so a client that discards everything at or below
    // it neither loses bytes nor draws the repaint twice.
    assert.equal(snapshot.seq, stream.buffer.headSeq);
    assert.equal(stream.buffer.since(snapshot.seq).length, 0);
    assert.equal(snapshot.epoch, stream.epoch);
  });
});

void describe("data is the live screen, not what the ring buffer happens to hold", () => {
  void test("scrollback that is already in history is not repeated in data", async () => {
    // The defect in the shape a real pane produces it: 400 lines arrive while attached, so `data` as
    // the buffer's contents sends the scrolled-off ones a SECOND time, after `history`.
    const { session } = await registry.create(work, "burst");
    await hub.sync();
    const stream = streamOf(session.id);
    await waitFor(stream, "BURST-TAIL-MARKER");
    await quiet(stream);

    // The precondition, asserted rather than assumed: the old source really did hold these lines.
    const buffered = stream.buffer.snapshot().toString("utf8");
    assert.match(buffered, /burst-line-1$/m, "the ring buffer did not hold the burst");

    const snapshot = await coldSnapshot(session.id, stream);
    assert.match(snapshot.data, /BURST-TAIL-MARKER/, "the live screen is not in the snapshot");
    assert.doesNotMatch(
      snapshot.data,
      /burst-line-1$/m,
      "data carried a line that scrolled off the screen, which history already had",
    );
    assert.ok(snapshot.history);
    assert.match(snapshot.history, /burst-line-1$/m, "the scrolled-off lines belong in history");
    assert.equal(snapshot.seq, stream.buffer.headSeq);
  });
});

void describe("alternate screen, which capture-pane cannot be trusted in", () => {
  void test("history is absent rather than the TUI's own frame", async () => {
    const { session } = await registry.create(work, "tui");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await hub.sync();
    const stream = streamOf(session.id);
    await quiet(stream);

    assert.equal(
      await hub.isAlternateScreen(session.id),
      true,
      "#{alternate_on} did not report a pane that has written \\033[?1049h",
    );

    // What the capture WOULD have returned, so the absence below is measured against the wrong answer
    // it prevents. Non-empty, so "absent rather than empty" would not have dropped it on its own.
    const wouldHaveCaptured = await hub.captureHistory(session.id, 2000);
    assert.notEqual(wouldHaveCaptured, "", "then the empty check alone would have covered this");
    assert.doesNotMatch(
      wouldHaveCaptured,
      /before-the-tui-started/,
      "capture-pane returned the real scrollback after all, which would change the argument",
    );

    const snapshot = await coldSnapshot(session.id, stream);
    assert.equal("history" in snapshot, false, "the TUI's frame was sent as scrollback");
    assert.match(snapshot.data, /TUI-FRAME-MARKER/, "the live screen is still the live screen");
    assert.equal(snapshot.seq, stream.buffer.headSeq);
  });

  void test("#{alternate_on} prints clean ASCII to a client with no locale at all", async () => {
    // The locale hazard, checked for the one command this item added that PRINTS to a client: raw
    // bytes, on a client whose environment is PATH and nothing else.
    const { session } = await registry.create(work, "tui");
    const ask = (target: string): Buffer =>
      execFileSync(
        "tmux",
        ["-L", socket, "display-message", "-p", "-t", target, "#{alternate_on}"],
        { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } },
      );

    const raw = ask(`=${session.id}:`);
    assert.deepEqual(
      [...raw],
      [...Buffer.from("1\n", "utf8")],
      `tmux printed ${raw.toString("hex")}, so the format was sanitised on its way out`,
    );

    // Why the target is the WINDOW one: `alternate_on` is a pane property, and a session target
    // prints an empty line with no error - read as "not on the alternate screen", silently.
    assert.deepEqual([...ask(`=${session.id}`)], [...Buffer.from("\n", "utf8")]);
  });
});
