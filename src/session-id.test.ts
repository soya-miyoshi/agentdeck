import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sessionId, sessionName } from "./session-id.ts";

void describe("session ids", () => {
  void test("is a pure function of (path, agent), so it survives a restart", () => {
    const first = sessionId("/workspace/agentdeck", "claude");
    const second = sessionId("/workspace/agentdeck", "claude");
    assert.equal(first, second);
  });

  void test("two checkouts with the same basename under different parents do not collide", () => {
    // The failure this prevents is the expensive one: a collision means `new-session -A`
    // silently attaches to somebody else's agent instead of starting one.
    const a = sessionId("/workspace/acme/web", "claude");
    const b = sessionId("/workspace/other/web", "claude");
    assert.notEqual(a, b);
    // Both still readable as `web` in `tmux ls`, which is the point of keeping the basename.
    assert.ok(a.startsWith("web-claude-"));
    assert.ok(b.startsWith("web-claude-"));
  });

  void test("the same path under two agents produces two ids", () => {
    // Without the agent in the key, a second create in one directory attaches to the agent already
    // there and returns a session whose `agent` field is a lie.
    const claude = sessionId("/workspace/agentdeck", "claude");
    const gemini = sessionId("/workspace/agentdeck", "gemini");
    assert.notEqual(claude, gemini);
  });

  void test("the same path and agent produce the same id, so `-A` reattaches", () => {
    // The deliberate collision: two identical agents in one tree is more often a forgotten tab
    // than an intention, and handing back the running one is the better failure.
    assert.equal(
      sessionId("/workspace/agentdeck", "claude"),
      sessionId("/workspace/agentdeck", "claude"),
    );
  });

  void test("characters tmux rejects never reach the name", () => {
    // tmux rejects `.` and `:` in a session name outright.
    for (const cwd of ["/workspace/my.repo", "/workspace/host:port", "/workspace/a b"]) {
      const id = sessionId(cwd, "claude");
      assert.doesNotMatch(id, /[.:\s]/, `${id} contains a character tmux rejects`);
    }
  });

  void test("names differing only in punctuation still produce different ids", () => {
    // Sanitising alone would fold these together; the path hash is what keeps them apart.
    assert.notEqual(
      sessionId("/workspace/my.repo", "claude"),
      sessionId("/workspace/my-repo", "claude"),
    );
  });

  void test("a path with nothing left after sanitising still yields a usable name", () => {
    const id = sessionId("/", "claude");
    assert.doesNotMatch(id, /^-/, "a leading dash reads as a flag to tmux");
    assert.ok(id.length > 0);
  });

  void test("the tab shows the unsanitised basename", () => {
    assert.equal(sessionName("/workspace/my.repo"), "my.repo");
  });
});
