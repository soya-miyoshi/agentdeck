import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { logicalLines } from "./select-text.ts";

const source = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

void describe("the text a person selects from", () => {
  void test("a soft-wrapped URL comes back as one line", () => {
    const url = "https://example.com/a/very/long/url/that/someone/wants/to/copy?with=query";
    const rows = [
      { text: url.slice(0, 50), wrapped: false },
      { text: url.slice(50), wrapped: true },
      { text: "$ ", wrapped: false },
    ];
    assert.deepEqual(logicalLines(rows, 100), [url, "$ "]);
  });

  void test("a real newline stays a line break", () => {
    const rows = [
      { text: "one", wrapped: false },
      { text: "two", wrapped: false },
    ];
    assert.deepEqual(logicalLines(rows, 100), ["one", "two"]);
  });

  void test("the empty rows below the cursor are not content", () => {
    const rows = [
      { text: "output", wrapped: false },
      { text: "", wrapped: false },
      { text: "  ", wrapped: false },
    ];
    assert.deepEqual(logicalLines(rows, 100), ["output"]);
  });

  void test("only the newest lines are kept, so a long scrollback stays a usable page", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      text: `line ${String(i)}`,
      wrapped: false,
    }));
    assert.deepEqual(logicalLines(rows, 3), ["line 7", "line 8", "line 9"]);
  });

  void test("a wrapped row with nothing above it is still kept", () => {
    assert.deepEqual(logicalLines([{ text: "tail", wrapped: true }], 10), ["tail"]);
  });
});

void describe("the select view as it is wired into the page", () => {
  const view = source("SelectText.vue");

  void test("its text is selectable by the platform, which the terminal's is not", () => {
    // The terminal claims every touch for scrolling, so the selection has to happen on plain text
    // the browser owns: long-press, drag handles and the system Copy menu all come from that.
    assert.match(view, /user-select:\s*text/);
    assert.match(view, /-webkit-user-select:\s*text/);
    assert.match(view, /touch-action:\s*(auto|pan-y)/);
    assert.match(view, /<pre/);
  });

  void test("it can always be left, from the bottom of the screen", () => {
    assert.match(view, />\s*Done\s*</);
    assert.match(view, /emit\(["']close["']\)/);
  });
});
