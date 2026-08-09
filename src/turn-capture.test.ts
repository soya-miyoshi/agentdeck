import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { turnFromHookEvent } from "./claude-hooks.ts";
import { TurnLog } from "./turn-log.ts";

// Against the payloads that were actually captured, not payloads written to match the parser.
// `src/fixtures/claude-turns.jsonl` is claude 2.1.226 on 2026-08-09: three real turns, recorded by
// pointing --settings at a throwaway file whose hooks appended their stdin to a log.

const payloads = readFileSync(join(import.meta.dirname, "fixtures", "claude-turns.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const eventsNamed = (name: string): Record<string, unknown>[] =>
  payloads.filter((payload) => payload["hook_event_name"] === name);

void describe("the captured turn payloads", () => {
  void test("the fixture holds the three turns the plan describes", () => {
    assert.equal(eventsNamed("UserPromptSubmit").length, 3);
    assert.equal(eventsNamed("Stop").length, 3);
  });

  void test("every captured Stop yields an answer, and every prompt yields an ask", () => {
    for (const payload of eventsNamed("Stop")) {
      const part = turnFromHookEvent(payload);
      assert.equal(part?.kind, "answer");
    }
    for (const payload of eventsNamed("UserPromptSubmit")) {
      const part = turnFromHookEvent(payload);
      assert.equal(part?.kind, "ask");
    }
  });

  void test("the two events of a turn carry the same prompt_id", () => {
    const asks = new Set(eventsNamed("UserPromptSubmit").map((p) => p["prompt_id"]));
    for (const stop of eventsNamed("Stop")) assert.ok(asks.has(stop["prompt_id"]));
  });

  void test("the long markdown answer arrives whole and free of escapes", () => {
    const longest = eventsNamed("Stop")
      .map((payload) => payload["last_assistant_message"])
      .filter((value): value is string => typeof value === "string")
      .sort((a, b) => b.length - a.length)[0];
    assert.ok(longest !== undefined);
    // The capture is 3776 characters of markdown, with a fenced block and a list in it.
    assert.ok(longest.length > 3000, `captured answer was ${String(longest.length)} chars`);
    assert.match(longest, /```/);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(longest, /\[/, "an ANSI escape reached the turn text");
  });

  void test("a fixture turn survives the store byte for byte", () => {
    const stop = eventsNamed("Stop").find(
      (payload) => typeof payload["last_assistant_message"] === "string",
    );
    const answer = stop?.["last_assistant_message"] as string;
    const log = new TurnLog(mkdtempSync(join(tmpdir(), "agentdeck-capture-")));
    log.recordAnswer("s", "p1", answer, 1000);
    assert.equal(log.read("s", 10).turns[0]?.answer, answer);
  });

  void test("an unknown field in the payload changes nothing", () => {
    // `effort` appeared between claude 2.1.221 and 2.1.226. A parser that fails on a field it has
    // not seen would break on the next release, so this pins the opposite.
    const stop = eventsNamed("Stop")[0];
    const part = turnFromHookEvent({ ...stop, some_field_shipped_next_year: 1 });
    assert.equal(part?.kind, "answer");
  });
});
