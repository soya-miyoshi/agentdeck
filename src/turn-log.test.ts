import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { MAX_FIELD_CHARS, MAX_TURNS, TurnLog } from "./turn-log.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "agentdeck-turns-"));

void describe("the turn log", () => {
  void test("pairs the two halves on prompt_id and keeps the text as written", () => {
    const log = new TurnLog(dir());
    log.noteAsk("s", "p1", "what is a pty", 1000);
    assert.equal(log.recordAnswer("s", "p1", "A PTY is a pair of devices.", 2000), true);

    const { turns } = log.read("s", 10);
    assert.deepEqual(turns, [
      {
        promptId: "p1",
        askedAt: 1000,
        endedAt: 2000,
        prompt: "what is a pty",
        answer: "A PTY is a pair of devices.",
      },
    ]);
  });

  void test("an answer whose prompt was never seen is still kept, without a prompt", () => {
    // The server restarting mid-turn, or a session started outside the deck. The answer is the
    // half that is hard to get back, so losing it to a missing question would be the wrong trade.
    const log = new TurnLog(dir());
    assert.equal(log.recordAnswer("s", "p1", "done", 2000), true);
    assert.equal(log.read("s", 10).turns[0]?.prompt, "");
  });

  void test("a pending prompt from another turn is not attached to this answer", () => {
    const log = new TurnLog(dir());
    log.noteAsk("s", "p1", "the first question", 1000);
    log.recordAnswer("s", "p2", "an answer to something else", 2000);
    assert.equal(log.read("s", 10).turns[0]?.prompt, "");
  });

  void test("a re-fired Stop for the same turn does not double the log", () => {
    // stop_hook_active in the payload says a Stop can fire again for a turn already ended.
    const log = new TurnLog(dir());
    log.noteAsk("s", "p1", "q", 1000);
    assert.equal(log.recordAnswer("s", "p1", "a", 2000), true);
    assert.equal(log.recordAnswer("s", "p1", "a", 2100), false);
    assert.equal(log.read("s", 10).turns.length, 1);
  });

  void test("an empty answer logs nothing at all", () => {
    // Plan 007 could not capture a turn whose last block is a tool call, so "no text" is treated
    // as nothing to record rather than as a shape that was observed.
    const log = new TurnLog(dir());
    log.noteAsk("s", "p1", "q", 1000);
    assert.equal(log.recordAnswer("s", "p1", "", 2000), false);
    assert.equal(log.read("s", 10).turns.length, 0);
  });

  void test("a long answer is cut on a character boundary and says it was cut", () => {
    const log = new TurnLog(dir());
    // Astral-plane characters: a byte-wise cut would split one and write a broken character.
    const long = "\u{1F600}".repeat(MAX_FIELD_CHARS + 100);
    log.recordAnswer("s", "p1", long, 2000);
    const turn = log.read("s", 10).turns[0];
    assert.equal(turn?.truncated, true);
    assert.equal(Array.from(turn?.answer ?? "").length, MAX_FIELD_CHARS);
    assert.ok(!(turn?.answer ?? "").includes("�"));
    assert.equal(
      Array.from(turn?.answer ?? "").every((c) => c === "\u{1F600}"),
      true,
    );
  });

  void test("non-ASCII survives the round trip", () => {
    // Captured for real in fixtures/claude-turns.jsonl, and the locale handling in tmux.ts exists
    // because this assumption was wrong once already on another path.
    const log = new TurnLog(dir());
    log.recordAnswer("s", "p1", "ターミナルの行折り返し", 2000);
    assert.equal(log.read("s", 10).turns[0]?.answer, "ターミナルの行折り返し");
  });

  void test("the file is trimmed to the newest turns rather than growing forever", () => {
    const log = new TurnLog(dir());
    for (let i = 0; i < MAX_TURNS + 20; i += 1) {
      log.recordAnswer("s", `p${String(i)}`, `answer ${String(i)}`, 1000 + i);
    }
    const { turns } = log.read("s", MAX_TURNS + 100);
    assert.equal(turns.length, MAX_TURNS);
    // Newest first, and the oldest are the ones dropped.
    assert.equal(turns[0]?.promptId, `p${String(MAX_TURNS + 19)}`);
    assert.equal(turns.at(-1)?.promptId, "p20");
  });

  void test("newest first, and the limit is applied to the newest end", () => {
    const log = new TurnLog(dir());
    log.recordAnswer("s", "p1", "first", 1000);
    log.recordAnswer("s", "p2", "second", 2000);
    log.recordAnswer("s", "p3", "third", 3000);
    const { turns, truncated } = log.read("s", 2);
    assert.deepEqual(
      turns.map((t) => t.promptId),
      ["p3", "p2"],
    );
    assert.equal(truncated, true);
  });

  void test("a session with no log is empty rather than an error", () => {
    const log = new TurnLog(dir());
    assert.deepEqual(log.read("never-started", 10), { turns: [], truncated: false });
  });

  void test("a torn last line loses that turn and nothing else", () => {
    const root = dir();
    const log = new TurnLog(root);
    log.recordAnswer("s", "p1", "kept", 1000);
    writeFileSync(join(root, "s.jsonl"), `${readFileSync(join(root, "s.jsonl"), "utf8")}{"prom`);
    const { turns } = log.read("s", 10);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.answer, "kept");
  });

  void test("a session id that would escape the directory writes nothing", () => {
    // The id reaching this class comes from a URL. It is checked here rather than trusted from
    // two callers away, because this is the layer that turns it into a path.
    const root = dir();
    const log = new TurnLog(root);
    assert.equal(log.recordAnswer("../escape", "p1", "a", 1000), false);
    assert.equal(log.recordAnswer("nested/id", "p1", "a", 1000), false);
    assert.deepEqual(log.read("../escape", 10), { turns: [], truncated: false });
  });

  void test("one session's answers never appear in another's", () => {
    const log = new TurnLog(dir());
    log.recordAnswer("alpha", "p1", "alpha's answer", 1000);
    log.recordAnswer("beta", "p1", "beta's answer", 1000);
    assert.equal(log.read("alpha", 10).turns[0]?.answer, "alpha's answer");
    assert.equal(log.read("beta", 10).turns[0]?.answer, "beta's answer");
  });
});
