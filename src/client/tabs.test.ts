import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import type { AgentSummary } from "../agent-profiles.ts";
import type { Session } from "../registry.ts";
import type { SessionState } from "../tmux.ts";
import { selectTab, toTabs } from "./tabs.ts";

const session = (
  id: string,
  agent: string,
  state: SessionState,
  exitCode?: number,
  waitingDetectionLost?: true,
): Session => ({
  id,
  name: id,
  cwd: `/work/${id}`,
  agent,
  state,
  startedAt: 0,
  ...(exitCode === undefined ? {} : { exitCode }),
  ...(waitingDetectionLost === undefined ? {} : { waitingDetectionLost }),
});

const agent = (id: string, detectsWaiting: boolean): AgentSummary => ({
  id,
  name: id,
  available: true,
  logsTurns: false,
  detectsWaiting,
});

void describe("the tab strip", () => {
  void test("one tab per session, in the order the server listed them", () => {
    const tabs = toTabs(
      [session("a", "claude", "working"), session("b", "shell", "idle")],
      [agent("claude", true), agent("shell", false)],
    );
    assert.deepEqual(
      tabs.map((tab) => [tab.id, tab.status]),
      [
        ["a", "working"],
        ["b", "idle"],
      ],
    );
  });

  void test("an exited tab shows its exit code", () => {
    // "exited 1" is the answer to "did it finish, or did I lose it".
    const [tab] = toTabs([session("a", "claude", "exited", 1)], [agent("claude", true)]);
    assert.equal(tab?.status, "exited 1");
    assert.equal(tab?.needsYou, false);
  });

  void test("an exited tab with no readable code says so rather than inventing a zero", () => {
    const [tab] = toTabs([session("a", "claude", "exited")], [agent("claude", true)]);
    assert.equal(tab?.status, "exited");
  });

  void test("an agent that detects waiting gets the needs-you indicator", () => {
    const [tab] = toTabs([session("a", "claude", "waiting")], [agent("claude", true)]);
    assert.equal(tab?.needsYou, true);
    assert.equal(tab?.status, "waiting");
  });
});

void describe("detectsWaiting: false is a supported configuration, not a defect", () => {
  void test("such an agent never shows a needs-you indicator", () => {
    const [tab] = toTabs([session("a", "shell", "waiting")], [agent("shell", false)]);
    assert.equal(tab?.needsYou, false);
    // Displayed as what the process is in fact doing. The client does not invent a state the
    // server is in no position to claim.
    assert.equal(tab?.status, "working");
  });

  void test("an agent the server has no summary for is treated as not detecting", () => {
    // A session can outlive the profile that started it. A missing indicator is the failure this
    // direction; a wrong one is the failure the other.
    const [tab] = toTabs([session("a", "gone", "waiting")], []);
    assert.equal(tab?.needsYou, false);
  });
});

void describe("a session whose waiting detection died", () => {
  void test("is visibly distinct from a healthy one, not identical to it", () => {
    const [healthy, deaf] = toTabs(
      [session("a", "claude", "working"), session("b", "claude", "working", undefined, true)],
      [agent("claude", true)],
    );
    // The whole point: two tabs in the same state must not render the same when one of them will
    // never again tell the user it needs them.
    assert.equal(healthy?.waitingDetectionLost, false);
    assert.equal(deaf?.waitingDetectionLost, true);
    assert.notDeepEqual(healthy, deaf);
  });

  void test("an agent that never detected waiting is not reported as having lost it", () => {
    // Nothing died here - this is the supported configuration. Saying "no waiting alerts" on
    // every shell tab is noise, and noise on every tab is how a real warning stops being read.
    const [tab] = toTabs(
      [session("a", "shell", "working", undefined, true)],
      [agent("shell", false)],
    );
    assert.equal(tab?.waitingDetectionLost, false);
  });

  void test("an exited session does not carry it", () => {
    // A finished process is not going to need anybody. The question the flag answers is not being
    // asked about this tab.
    const [tab] = toTabs([session("a", "claude", "exited", 0, true)], [agent("claude", true)]);
    assert.equal(tab?.waitingDetectionLost, false);
  });
});

void describe("which tab stays selected when the list changes", () => {
  const tabs = toTabs(
    [session("a", "shell", "idle"), session("b", "shell", "idle")],
    [agent("shell", false)],
  );

  void test("a still-present selection is kept, so a session exiting elsewhere moves nothing", () => {
    assert.equal(selectTab(tabs, "b"), "b");
  });

  void test("a selection that has gone falls back to the first tab", () => {
    assert.equal(selectTab(tabs, "vanished"), "a");
  });

  void test("no tabs at all is no selection, not an empty string", () => {
    assert.equal(selectTab([], "a"), undefined);
  });
});

// `toTabs` deciding the flag is only half of "visibly distinct": a strip that computed it and
// never rendered it would pass every test above while looking exactly like a healthy tab on the
// phone, which is the failure this item names. There is no DOM here and no renderer in the
// dependency budget, so the template itself is read - the cheapest thing that fails if the flag
// stops reaching the screen.
void describe("the strip renders the flag rather than only computing it", () => {
  const template = readFileSync(new URL("./TabStrip.vue", import.meta.url), "utf8")
    // Comments explain the decision; they do not draw anything. Reading them as evidence would
    // let the rendering be deleted and leave the prose behind, which is the worst of both.
    .replace(/<!--[\s\S]*?-->/g, "");

  void test("a tab that lost waiting detection is drawn differently", () => {
    assert.match(template, /v-if="tab\.waitingDetectionLost"/);
    assert.match(template, /deaf: tab\.waitingDetectionLost/);
  });

  void test("it says so in words, not in a shade of grey", () => {
    // A colour alone is not a difference a person can name, and on the phone it is the difference
    // between two greys. The words are what let somebody act on it.
    assert.match(template, /no waiting alerts/);
  });

  void test("no emojis, here as everywhere", () => {
    assert.doesNotMatch(template, /\p{Extended_Pictographic}/u);
  });
});
