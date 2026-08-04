import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bearerFrom, generateToken, isWireSafe, tokenMatches } from "./token.ts";

void describe("token generation", () => {
  void test("every generated token survives Sec-WebSocket-Protocol", () => {
    // One token passing proves nothing: the obvious base64 mistake produces a working token most
    // of the time and fails for roughly one user in four. Generate enough to catch it.
    for (let i = 0; i < 500; i++) {
      const token = generateToken();
      assert.ok(isWireSafe(token), `${token} is not an RFC 7230 token`);
      assert.doesNotMatch(token, /[/+=\s]/, `${token} carries a character the handshake rejects`);
    }
  });

  void test("padded base64 is what the alphabet check exists to reject", () => {
    // Documents the trap rather than just avoiding it: if someone swaps the encoding back, the
    // test above starts failing and this explains why.
    assert.equal(isWireSafe("abc/def+ghi="), false);
  });

  void test("tokens are unique and long enough to be worth having", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateToken());
    assert.equal(seen.size, 200);
    assert.ok(generateToken().length >= 40);
  });
});

void describe("token comparison", () => {
  void test("matches itself and nothing else", () => {
    const token = generateToken();
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(generateToken(), token), false);
  });

  void test("a length mismatch is false rather than a throw", () => {
    // timingSafeEqual throws on unequal buffers; a 500 on a wrong token is a bug report.
    assert.equal(tokenMatches("short", generateToken()), false);
    assert.equal(tokenMatches("", generateToken()), false);
  });

  void test("a prefix of the real token does not match", () => {
    const token = generateToken();
    assert.equal(tokenMatches(token.slice(0, -1), token), false);
  });
});

void describe("bearer extraction", () => {
  void test("reads a well-formed header", () => {
    assert.equal(bearerFrom("Bearer abc123"), "abc123");
  });

  void test("rejects everything else", () => {
    for (const header of [undefined, "", "abc123", "bearer abc123", "Bearer", "Bearer a b"]) {
      assert.equal(bearerFrom(header), undefined, `accepted ${String(header)}`);
    }
  });
});
