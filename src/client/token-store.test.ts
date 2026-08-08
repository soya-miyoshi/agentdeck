import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  clearToken,
  loadToken,
  normaliseToken,
  saveToken,
  type TokenStorage,
} from "./token-store.ts";

const memory = (initial?: string): TokenStorage => {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("agentdeck.token", initial);
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
};

const throwing: TokenStorage = {
  getItem: () => {
    throw new Error("storage is disabled");
  },
  setItem: () => {
    throw new Error("storage is disabled");
  },
  removeItem: () => {
    throw new Error("storage is disabled");
  },
};

void describe("the pasted token", () => {
  void test("whitespace is trimmed off", () => {
    // The header this ends up in is an RFC 7230 token: a trailing newline from a terminal makes
    // the handshake fail at the socket layer, with nothing logged anywhere.
    assert.equal(normaliseToken("  abc123\n"), "abc123");
  });

  void test("nothing at all is undefined rather than an empty token", () => {
    assert.equal(normaliseToken("   "), undefined);
  });
});

void describe("holding the token across a backgrounding", () => {
  void test("a stored token is loaded back", () => {
    // A token that has to be re-entered after every backgrounding is a token that gets pasted
    // into a note instead.
    const storage = memory();
    saveToken(storage, "abc123");
    assert.equal(loadToken(storage), "abc123");
  });

  void test("clearing it means the paste field, not a stale token", () => {
    const storage = memory("abc123");
    clearToken(storage);
    assert.equal(loadToken(storage), undefined);
  });

  void test("a fresh page against the same storage finds it, whitespace and all", () => {
    // What "survives backgrounding the app" is, from here: the installed PWA has its own storage
    // partition (m4/pwa), and a resume is a fresh page against that same partition. So the load
    // has to work against a store this module did not write in this run, including a token that
    // was stored before `accept` started trimming - the header it ends up in cannot carry a
    // newline, and the failure would be a socket that never opens with nothing logged.
    //
    // NOT DEMONSTRATED here, and it needs a phone: that iOS still holds the partition after it
    // has evicted and resumed the installed app. No test on this machine can make that claim.
    const survived = memory("abc123\n");
    assert.equal(loadToken(survived), "abc123");
  });

  void test("a browser that refuses to store still runs this session", () => {
    assert.equal(loadToken(throwing), undefined);
    assert.doesNotThrow(() => {
      saveToken(throwing, "abc123");
    });
    assert.doesNotThrow(() => {
      clearToken(throwing);
    });
  });
});

void describe("the rejected-token path lands on the paste field", () => {
  // M2 already decided what a `rejected` verdict does: it stops the reconnect ladder, sets the
  // status to `rejected` and calls `unauthorized()`, and `src/client/connection.test.ts` holds
  // that. What no test held is the last hop - that App.vue's `unauthorized` handler is the one
  // that clears the stored token, rather than leaving a token that the server has already refused
  // in `localStorage` for the next reload to retry with. That hop lives in an SFC, which has no
  // module boundary a unit test can reach, so it is asserted on the source.
  void test("App.vue routes unauthorized to signOut, and signOut clears the stored token", () => {
    const source = readFileSync(join(import.meta.dirname, "App.vue"), "utf8");
    assert.match(source, /unauthorized: \(\) => \{\s*signOut\(/);
    assert.match(source, /const signOut = [\s\S]*?clearToken\(window\.localStorage\)/);
    // And the gate is what renders when there is no token.
    assert.match(source, /<TokenGate v-if="token === undefined"/);
  });

  void test("signing out drops the live connection as well as the token", () => {
    // Clearing storage while a socket stays up would leave the page connected on a credential the
    // user can no longer see and cannot replace, and the ladder would keep re-presenting it.
    const source = readFileSync(join(import.meta.dirname, "App.vue"), "utf8");
    const signOut = /const signOut = \(message: string\): void => \{([\s\S]*?)\n\};/.exec(source);
    assert.ok(signOut, "signOut is no longer where the rejected path lands");
    const body = signOut[1] ?? "";
    assert.match(body, /connection\.value\?\.stop\(\)/);
    assert.match(body, /clearToken\(window\.localStorage\)/);
    assert.match(body, /token\.value = undefined/);
    // The server's own sentence is what the gate then shows, rather than a blank field.
    assert.match(body, /gateMessage\.value = message/);
  });

  void test("the 401 on the REST side lands in the same place as the socket verdict", () => {
    // Two doors, one answer. An `UnauthorizedError` from the session list means the same thing a
    // `rejected` verdict does, and if only the socket path cleared the token a reload would retry
    // forever against a token the server has already refused.
    const source = readFileSync(join(import.meta.dirname, "App.vue"), "utf8");
    assert.match(source, /error instanceof UnauthorizedError\)\s*\{\s*signOut\(/);
  });

  void test("a pasted token is stored, which is what makes a resume free", () => {
    const source = readFileSync(join(import.meta.dirname, "App.vue"), "utf8");
    assert.match(
      source,
      /const accept = \(pasted: string\): void => \{\s*saveToken\(window\.localStorage, pasted\)/,
    );
  });
});
