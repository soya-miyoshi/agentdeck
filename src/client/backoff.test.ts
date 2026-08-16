import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BACKOFF_CAP_MS, backoffDelay, ReconnectPolicy } from "./backoff.ts";

// The ladder is asserted with the jitter pinned to its top - `() => 1` is "no spread" - so these
// still describe the shape they always did. The spread itself is the test below them.
const unjittered = (): number => 1;

void describe("backoff timing", () => {
  void test("doubles from the first retry", () => {
    assert.deepEqual(
      [0, 1, 2, 3].map((attempt) => backoffDelay(attempt, unjittered)),
      [250, 500, 1000, 2000],
    );
  });

  void test("caps low, because the user is looking at the screen", () => {
    assert.equal(backoffDelay(6, unjittered), BACKOFF_CAP_MS);
    assert.equal(backoffDelay(50, unjittered), BACKOFF_CAP_MS);
    assert.ok(BACKOFF_CAP_MS <= 5000);
  });

  void test("spreads, so clients woken by one stalled server do not return together", () => {
    // Every silence deadline is armed off ONE server timer, so a stall expires all of them at once -
    // and without spread every tab re-attaches together, at the loop that was already stalled.
    const spread = new Set([0, 0.25, 0.5, 0.75, 1].map((r) => backoffDelay(3, () => r)));
    assert.ok(spread.size > 1, "the delay is identical regardless of the draw");
    for (const delay of spread) {
      assert.ok(delay <= 2000, "jitter must not extend the wait past the ladder's own step");
      assert.ok(delay >= 1000, "jitter must not collapse the wait to nothing");
    }
  });
});

void describe("the reconnection ladder", () => {
  void test("the first retry is immediate-ish and silent", () => {
    // A normal half-second reconnect must not flash UI at the user for something they would
    // otherwise never have noticed.
    const decision = new ReconnectPolicy(unjittered).closed("network");
    assert.deepEqual(decision, { retry: true, delayMs: 250, showReconnecting: false });
  });

  void test("the reconnecting affordance appears only once the first retry has failed", () => {
    const policy = new ReconnectPolicy();
    assert.equal(policy.closed("network").showReconnecting, false);
    assert.equal(policy.closed("network").showReconnecting, true);
    assert.equal(policy.closed("network").showReconnecting, true);
  });

  void test("a successful open starts the ladder from the bottom again", () => {
    const policy = new ReconnectPolicy(unjittered);
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
