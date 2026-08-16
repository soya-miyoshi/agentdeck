// Closing a session from the phone: the route existed, the way to reach it did not. One tap must not
// kill an agent, and the cap must not be reachable on a tab nobody is looking at.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { closeSession, UnauthorizedError } from "./api.ts";
import { nextArm } from "./close-arm.ts";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

void describe("the close cap arms before it acts", () => {
  void test("the first tap arms and closes nothing", () => {
    // The whole point. An agent an hour into a task is not something a mis-hit may end.
    assert.deepEqual(nextArm(undefined, "a"), { armed: "a", close: false });
  });

  void test("the second tap on the SAME tab closes, and disarms as it goes", () => {
    assert.deepEqual(nextArm("a", "a"), { armed: undefined, close: true });
    // Disarmed afterwards, so the cap cannot be left hot for a tab that no longer exists.
    assert.equal(nextArm(nextArm("a", "a").armed, "a").close, false);
  });

  void test("a tap on a different tab moves the arm rather than closing", () => {
    // The failure this forbids: arm one tab, look away, tap another, and kill the wrong agent.
    assert.deepEqual(nextArm("a", "b"), { armed: "b", close: false });
    assert.equal(nextArm("a", "b").close, false);
  });
});

void describe("the request the cap sends", () => {
  void test("is a DELETE at the session's own path, with the token", async () => {
    let seen: { url: string; method: string | undefined; auth: string | undefined } | undefined;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: input instanceof Request ? input.url : String(input),
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.["authorization"],
      };
      return await Promise.resolve(
        new Response(JSON.stringify({ closed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    await closeSession("tok", "repo-claude-1a2b3c4d");
    assert.equal(seen?.method, "DELETE");
    assert.equal(seen?.url, "/api/sessions/repo-claude-1a2b3c4d");
    assert.equal(seen?.auth, "Bearer tok");
  });

  void test("an id is encoded rather than pasted into the path", async () => {
    // The id reaches the server as one path segment and is re-checked there, but a client that
    // pastes it raw turns a session named with a slash into a request for another route.
    let url = "";
    globalThis.fetch = async (input: string | URL | Request) => {
      url = input instanceof Request ? input.url : String(input);
      return await Promise.resolve(new Response(JSON.stringify({ closed: true }), { status: 200 }));
    };
    await closeSession("tok", "a/b c");
    assert.equal(url, "/api/sessions/a%2Fb%20c");
  });

  void test("a rejected token is raised as itself, so the page shows the paste field", async () => {
    globalThis.fetch = async () =>
      await Promise.resolve(
        new Response(JSON.stringify({ error: "missing or invalid bearer token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );
    await assert.rejects(async () => {
      await closeSession("tok", "id");
    }, UnauthorizedError);
  });
});

void describe("the cap as it is wired into the page", () => {
  const strip = source("TabStrip.vue");
  const app = source("App.vue");

  void test("only the tab being looked at has a close cap", () => {
    // A close cap on every tab puts a destructive control a thumb's width from the control that
    // switches tabs, on tabs whose terminal is not even on screen.
    assert.match(strip, /v-if="tab\.id === active"[\s\S]{0,200}?class="close"|class="close"/);
    const close = /<button\s+v-if="tab\.id === active"[\s\S]*?<\/button>/.exec(strip)?.[0] ?? "";
    assert.notEqual(close, "", "the close cap is not conditional on the tab being active");
    assert.match(close, /class="close"/);
  });

  void test("the cap is a text label and says which tap it is on", () => {
    // The repository's no-glyph rule, and the armed state has to be READABLE: an armed cap that
    // looks like an unarmed one is a control whose next tap the person cannot predict.
    assert.doesNotMatch(strip, /\p{Extended_Pictographic}/u, "an emoji in the tab strip");
    assert.match(strip, /"Sure\?" : "Close"/);
    assert.match(strip, /\.close\.armed\s*\{/);
    assert.match(strip, /:aria-label=/);
  });

  void test("the strip keeps the rule in the module rather than a second copy", () => {
    assert.match(strip, /from "\.\/close-arm\.ts"/);
    assert.match(strip, /nextArm\(armed\.value, id\)/);
    // Switching tabs disarms: the arm belongs to the tab it was made on, the same reason the Ctrl
    // latch is dropped when the active tab moves.
    assert.match(strip, /watch\(\s*\(\) => props\.active/);
  });

  void test("the page closes the session and drops the tab without waiting for a sync", () => {
    assert.match(app, /@close="\(id\) => void endSession\(id\)"/);
    const end = /const endSession = async \(id: string\): Promise<void> => \{([\s\S]*?)\n\};/.exec(
      app,
    )?.[1];
    assert.ok(end !== undefined, "App.vue has no endSession()");
    assert.match(end, /await closeSession\(current, id\)/);
    // Removed from the list here: a tab left behind is one that can still be typed into, and the
    // keystrokes go to a session that is gone.
    assert.match(end, /sessions\.value\.filter\(\(session\) => session\.id !== id\)/);
    assert.match(end, /settle\(\)/);
    // And the picker's per-directory list is stale the moment a session ends.
    assert.match(end, /loadCwds\(\)/);
  });
});
