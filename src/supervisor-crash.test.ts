// What happens when the node process dies on this Mac: NOTHING RESTARTS IT. The crash itself is
// exercised against the Go server in server-go/; what stays here is that the plans say so.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

void describe("plan 003 says so in the plan, not only here", () => {
  void test("M0 states plainly that nothing restarts the server", async () => {
    const plan = await readFile(new URL("../plans/003-milestones.md", import.meta.url), "utf8");
    const m0 = plan.slice(plan.indexOf("## M0"), plan.indexOf("## M1"));
    assert.match(m0, /Nothing supervises Node/);
    assert.match(m0, /nothing restart(s|ed) the (node |Node )?(server|process)/i);
    assert.match(m0, /m0\/supervisor-crash-test/);
    // The metadata half: what a restart now recovers, and the one thing it cannot.
    assert.match(m0, /adopts/i, "M0 does not say the survivor is adopted");
    assert.match(m0, /waitingDetectionLost/, "M0 does not name what the survivor loses");
  });

  void test("M1's done-when describes a restart that lists the survivor by itself", async () => {
    // It used to say a plain list after a restart showed nothing. Adoption changed the behaviour,
    // so the plan changed with it - and the loss it cannot undo is named in the same sentence.
    const plan = await readFile(new URL("../plans/003-milestones.md", import.meta.url), "utf8");
    const m1 = plan.slice(plan.indexOf("## M1"), plan.indexOf("## M2"));
    assert.match(m1, /adopts/i);
    assert.match(m1, /waitingDetectionLost/);
  });
});

void describe("plan 002 states what a restart costs, because the client has to show it", () => {
  void test("the wire contract carries waitingDetectionLost and says why it exists", async () => {
    const plan = await readFile(new URL("../plans/002-wire-protocol.md", import.meta.url), "utf8");
    assert.match(plan, /waitingDetectionLost\?: true/, "the Session shape does not carry the flag");
    // The consequence, not just the field: the secret is unrecoverable and the agent must restart.
    assert.match(plan, /The hook secret is not recovered, and cannot be/);
    assert.match(plan, /never again report\s+`waiting`/);
    // And that adoption did not widen the boundary m0/host-boundary drew.
    assert.match(plan, /Adoption is bounded by the same allowlist/);
  });
});
