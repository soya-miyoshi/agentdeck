import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { hookCommand } from "./claude-hooks.ts";
import { MAX_FIELD_CHARS } from "./turn-log.ts";

// The hook COMMAND, run through a real shell against a real socket, because everything
// interesting about it happens outside this process. Plan 007 put the turn's text into a payload
// that used to carry an event name and nothing else, and the size of that text is what makes the
// transport worth testing rather than reading.

let server: Server;
let port = 0;
let received: Record<string, unknown> | undefined;
let receivedBytes = 0;

before(async () => {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(parts);
      receivedBytes = raw.length;
      // Decoded from the WHOLE body, never per chunk: a per-chunk decode turns a character split
      // by a read boundary into U+FFFD, and a test harness that does it cannot tell whether the
      // thing it is testing did.
      try {
        received = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        received = undefined;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
});

const post = async (payload: unknown): Promise<void> => {
  received = undefined;
  receivedBytes = 0;
  await new Promise<void>((done) => {
    const child = execFile(
      "/bin/sh",
      ["-c", hookCommand(port)],
      { env: { ...process.env, AGENTDECK_SESSION_ID: "s", AGENTDECK_SECRET: "x" } },
      // The command exits before its request is answered, so settle after it rather than with it.
      () => setTimeout(done, 400),
    );
    child.stdin?.end(JSON.stringify(payload));
  });
};

const answerOf = (): string => {
  const value = received?.["last_assistant_message"];
  return typeof value === "string" ? value : "";
};

void describe("a turn's text through the hook command", () => {
  void test("an ordinary answer arrives byte for byte", async () => {
    const answer = "# Heading\n\n- a list item\n\n```sh\necho hi\n```\n";
    await post({ hook_event_name: "Stop", prompt_id: "p", last_assistant_message: answer });
    assert.equal(answerOf(), answer);
  });

  void test("a huge answer is cut down to something the route will accept", async () => {
    // Before this cut existed, a long turn produced a body the route refused - so the turn lost
    // its STATE as well as its text, and a long turn is the one the log exists for.
    await post({
      hook_event_name: "Stop",
      prompt_id: "p",
      last_assistant_message: "X".repeat(500_000),
    });
    assert.ok(receivedBytes < 64 * 1024, `body was ${String(receivedBytes)} bytes`);
    assert.equal(received?.["hook_event_name"], "Stop", "the event name did not survive the cut");
  });

  void test("a cut answer arrives long enough for the store to know it was cut", async () => {
    // The property, not the mechanism: what matters is that the log can tell a truncated answer
    // from a whole one. Cutting to exactly the store's bound would make the two indistinguishable
    // and the log would call a truncated answer complete.
    await post({
      hook_event_name: "Stop",
      prompt_id: "p",
      last_assistant_message: "X".repeat(500_000),
    });
    assert.ok(
      Array.from(answerOf()).length > MAX_FIELD_CHARS,
      "the answer arrived at or under the store's bound, so the cut is invisible to it",
    );
  });

  void test("a large multi-byte answer arrives with every character intact", async () => {
    // 90KB of Japanese: several read boundaries, any of which could split a three-byte character
    // if the payload were decoded chunk by chunk. The characters are all identical, so anything
    // that is not that character is damage.
    const answer = "折".repeat(30_000);
    await post({ hook_event_name: "Stop", prompt_id: "p", last_assistant_message: answer });
    const points = Array.from(answerOf());
    assert.ok(points.length > 0, "nothing arrived");
    assert.deepEqual([...new Set(points)], ["折"]);
  });

  void test("a payload that is not JSON is dropped rather than sent as a broken body", async () => {
    received = undefined;
    receivedBytes = 0;
    await new Promise<void>((done) => {
      const child = execFile(
        "/bin/sh",
        ["-c", hookCommand(port)],
        { env: { ...process.env, AGENTDECK_SESSION_ID: "s", AGENTDECK_SECRET: "x" } },
        () => setTimeout(done, 400),
      );
      child.stdin?.end("X".repeat(400_000));
    });
    assert.equal(receivedBytes, 0, "an unparseable oversized payload was sent anyway");
  });
});
