import assert from "node:assert/strict";
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
