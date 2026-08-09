import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { Turn } from "../turn-log.ts";
import { headline, title, when } from "./turn-history.ts";

const turn = (fields: Partial<Turn>): Turn => ({
  promptId: "p",
  askedAt: 0,
  endedAt: 0,
  prompt: "",
  answer: "",
  ...fields,
});

void describe("what the answers list shows", () => {
  void test("a markdown heading becomes a plain title", () => {
    assert.equal(headline("# What Is a PTY?\n\nA PTY is..."), "What Is a PTY?");
    assert.equal(headline("- a bullet"), "a bullet");
  });

  void test("leading blank lines are skipped rather than shown as an empty row", () => {
    assert.equal(headline("\n\n  \nthe real first line\nmore"), "the real first line");
  });

  void test("a long line is cut with an ellipsis, on a character boundary", () => {
    const cut = headline("\u{1F600}".repeat(200), 10);
    assert.equal(Array.from(cut).length, 10);
    assert.ok(cut.endsWith("…"));
    assert.ok(!cut.includes("�"));
  });

  void test("a turn with no prompt is titled by its answer rather than by nothing", () => {
    // The prompt is empty when the server restarted mid-turn. A blank row would be unreadable.
    assert.equal(title(turn({ prompt: "", answer: "the answer" })), "the answer");
    assert.equal(title(turn({ prompt: "the question", answer: "the answer" })), "the question");
  });

  void test("the time is the clock, with the day named once it is not today", () => {
    // "the one from before lunch" is how a person looks for an answer, so this is a clock rather
    // than an age. Built from local-time arithmetic, never from a fixed offset.
    const today = new Date(2026, 7, 9, 14, 5).getTime();
    assert.equal(when(today, new Date(2026, 7, 9, 18, 0).getTime()), "14:05");
    assert.match(when(new Date(2026, 7, 8, 9, 30).getTime(), today), /^yesterday 09:30$/);
    assert.equal(when(new Date(2026, 6, 30, 9, 30).getTime(), today), "7/30 09:30");
  });

  void test("the answer is shown as text, never rendered as HTML", () => {
    // The one property that matters in the overlay's template: an answer is agent output and the
    // markdown in it is not markup we run. Interpolation escapes; v-html would not.
    const overlay = readFileSync(join(import.meta.dirname, "TurnHistory.vue"), "utf8");
    assert.doesNotMatch(overlay, /v-html/);
    assert.match(overlay, /\{\{ turn\.answer \}\}/);
  });
});
