import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BACKOFF_CAP_MS, backoffDelay, ReconnectPolicy } from "./backoff.ts";

void describe("backoff timing", () => {
  void test("doubles from the first retry", () => {
    assert.deepEqual([0, 1, 2, 3].map(backoffDelay), [250, 500, 1000, 2000]);
  });

  void test("caps low, because the user is looking at the screen", () => {
    assert.equal(backoffDelay(6), BACKOFF_CAP_MS);
    assert.equal(backoffDelay(50), BACKOFF_CAP_MS);
    assert.ok(BACKOFF_CAP_MS <= 5000);
  });
});

void describe("the reconnection ladder", () => {
  void test("the first retry is immediate-ish and silent", () => {
    // A normal half-second reconnect must not flash UI at the user for something they would
    // otherwise never have noticed.
    const decision = new ReconnectPolicy().closed("network");
    assert.deepEqual(decision, { retry: true, delayMs: 250, showReconnecting: false });
  });

  void test("the reconnecting affordance appears only once the first retry has failed", () => {
    const policy = new ReconnectPolicy();
    assert.equal(policy.closed("network").showReconnecting, false);
    assert.equal(policy.closed("network").showReconnecting, true);
    assert.equal(policy.closed("network").showReconnecting, true);
  });

  void test("a successful open starts the ladder from the bottom again", () => {
    const policy = new ReconnectPolicy();
    policy.closed("network");
    policy.closed("network");
    policy.opened();
    assert.deepEqual(policy.closed("network"), {
      retry: true,
      delayMs: 250,
      showReconnecting: false,
    });
  });

  void test("a rejected token stops the ladder rather than backing off forever", () => {
    // Backing off against a server that is answering correctly looks exactly like being out of
    // range, so the one thing the user could do about it never gets asked for.
    const policy = new ReconnectPolicy();
    policy.closed("network");
    assert.deepEqual(policy.closed("token-rejected"), {
      retry: false,
      delayMs: 0,
      showReconnecting: false,
    });
  });
});
