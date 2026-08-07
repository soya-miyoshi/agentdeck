import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { CwdAllowlist } from "./cwds.ts";

const list = new CwdAllowlist(["/workspace/agentdeck", "/workspace/web"]);

void describe("the cwd allowlist", () => {
  void test("allows exactly what is on the list", () => {
    assert.equal(list.allows("/workspace/agentdeck"), true);
    assert.equal(list.allows("/workspace/web"), true);
    assert.equal(list.allows("/workspace/other"), false);
  });

  void test("a trailing slash is the same directory", () => {
    assert.equal(list.allows("/workspace/agentdeck/"), true);
  });

  void test("traversal does not escape", () => {
    assert.equal(list.allows("/workspace/agentdeck/../../etc"), false);
    assert.equal(list.allows("/workspace/agentdeck/./../web"), true, "resolves to a mounted path");
  });

  void test("a subdirectory of a mounted repo is not itself startable", () => {
    // The list names repositories, not roots. Membership is exact rather than prefix.
    assert.equal(list.allows("/workspace/agentdeck/src"), false);
  });

  void test("a sibling sharing a prefix is refused", () => {
    // The failure a prefix test would allow: `/workspace/agentdeck-secrets` starts with an
    // allowed path but is a different directory entirely.
    assert.equal(list.allows("/workspace/agentdeck-secrets"), false);
  });

  void test("the refusal names what would have to change, and its cost", () => {
    const message = list.refusal("/workspace/newly-cloned");
    assert.match(message, /AGENTDECK_MOUNTS/);
    assert.match(message, /restart agentdeck/);
    assert.match(message, /\/workspace\/agentdeck/, "it should say what IS allowed");
  });

  void test("the refusal does not price the restart at a reconnect", () => {
    // The registry keeps cwd, agent and the per-session hook secret in memory only, so sessions
    // that survive the restart come back nameless and never report `waiting` again. A refusal
    // that says the restart costs "a reconnect" is what makes the losing action sound routine.
    const message = list.refusal("/workspace/newly-cloned");
    assert.doesNotMatch(message, /costs a reconnect/);
    assert.match(message, /waiting detection do not survive/);
    assert.match(message, /stop reporting when they need you/);
  });
});

void describe("plan 006 prices a restart at what it actually costs", () => {
  void test("it names the metadata the surviving sessions lose", async () => {
    const plan = await readFile(new URL("../plans/006-availability.md", import.meta.url), "utf8");
    assert.match(plan, /hook secret in memory only/);
    assert.match(plan, /never\s+reports `waiting` again/);
    assert.match(plan, /known gap/);
  });
});

void describe("what the picker is served", () => {
  void test("each entry carries its basename and the sessions already there", () => {
    const cwds = list.list(new Map([["/workspace/agentdeck", ["agentdeck-claude-abc"]]]));
    assert.deepEqual(cwds, [
      { path: "/workspace/agentdeck", name: "agentdeck", sessions: ["agentdeck-claude-abc"] },
      { path: "/workspace/web", name: "web", sessions: [] },
    ]);
  });

  void test("the returned session arrays are copies", () => {
    // The picker must not be able to mutate the registry's view by editing what it was handed.
    const live = ["a"];
    const [entry] = list.list(new Map([["/workspace/agentdeck", live]]));
    entry?.sessions.push("b");
    assert.deepEqual(live, ["a"]);
  });
});
