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

  void test("the refusal prices the restart at what it actually costs now", () => {
    // This used to demand the opposite wording. The restart cost every running session its
    // `waiting` alerts, because the hook secret was random and could not be handed to a process
    // already running, and the refusal had to say so or someone would restart casually and stop
    // being told they were needed. The secret is derived now and survives, so a refusal still
    // carrying that warning would OVERSTATE the price - which misleads exactly as much.
    const message = list.refusal("/workspace/newly-cloned");
    assert.doesNotMatch(message, /waiting detection stays dead/);
    assert.doesNotMatch(message, /secret does not survive/);
    assert.match(message, /still able to report waiting/);
    assert.match(message, /derived rather than minted/);
  });

  void test("the README prices it the same way, since that is what a person reads first", async () => {
    // Prose is where this regressed once already, in both directions: the README understated the
    // cost before m2, and would overstate it now if it still carried the old warning.
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    assert.doesNotMatch(readme, /never `waiting` again/);
    assert.match(readme, /hook\s+secret comes back too/);
    assert.match(readme, /HMAC\(bearer token, session id\)/);
  });
});

void describe("the prose states the exclusion by name, not by provenance", () => {
  // `Registry.#adopt` lists any session whose `#{session_path}` is allowlisted AND whose name is
  // `sessionId(that path, a configured agent)`. Provenance stopped being the criterion there, so a
  // document that still says a hand-started session cannot be a tab reads the risk as covered.
  const claims = [
    /agentdeck only knows a session's directory for the\s+sessions it started/,
    /start by hand[^.]*does \*\*not\*\* appear as a tab/,
    /session started by\s+hand under that socket does not appear as a tab/,
    /session started by hand in tmux does not appear as a tab/,
  ];

  const states: Record<string, RegExp> = {
    "../SECURITY.md": /its name is exactly the one\nagentdeck would derive/,
    "../plans/005-containment.md":
      /its name equals\n> `sessionId\(that path, a configured agent\)`/,
    "./hub.ts": /whose NAME is not `sessionId\(its allowlisted path, a configured agent\)`/,
  };

  for (const [file, states_] of Object.entries(states)) {
    void test(`${file} does not claim a hand-started session can never be listed`, async () => {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      for (const claim of claims) assert.doesNotMatch(text, claim);
      assert.match(text, states_, "it should state the exclusion by name instead");
    });
  }
});

void describe("the allowlist is a boundary, not only a check on POST /api/sessions", () => {
  void test("a session whose directory is unknown is never allowed", () => {
    // What a session started by hand on the tmux socket reports, and what one that outlived the
    // process that created it reports. `resolve("")` is the SERVER's working directory, so
    // without this an agentdeck started inside an allowlisted repository would adopt every
    // unknown session on the socket - the exact case the boundary exists for.
    assert.equal(list.allows(""), false);
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

void describe("a root is read on every check, not captured at boot", () => {
  /** An allowlist whose scan is a variable, so "cloned since" is expressible in a test. */
  const withRoots = (
    repos: string[],
  ): { list: CwdAllowlist; repos: string[]; scans: () => number } => {
    let scans = 0;
    const found = repos;
    const list = new CwdAllowlist(["/workspace/pinned"], ["/roots"], {
      scan: () => {
        scans += 1;
        return found;
      },
      ttlMs: 0,
    });
    return { list, repos: found, scans: () => scans };
  };

  void test("a repository cloned since the server started is startable", () => {
    const { list, repos } = withRoots(["/roots/host/owner/one"]);
    assert.equal(list.allows("/roots/host/owner/two"), false);
    repos.push("/roots/host/owner/two");
    assert.equal(list.allows("/roots/host/owner/two"), true, "no restart should be needed");
  });

  void test("the fixed entries survive alongside the scanned ones", () => {
    const { list } = withRoots(["/roots/host/owner/one"]);
    assert.equal(list.allows("/workspace/pinned"), true);
    assert.equal(list.allows("/roots/host/owner/one"), true);
  });

  void test("the root itself is not startable, and nor is a stranger under it", () => {
    // Membership stays exact. The root names where to look for repositories, not a prefix that
    // anything below it inherits.
    const { list } = withRoots(["/roots/host/owner/one"]);
    assert.equal(list.allows("/roots"), false);
    assert.equal(list.allows("/roots/host/owner"), false);
    assert.equal(list.allows("/roots/host/owner/one/src"), false);
  });

  void test("a scan is reused within its window rather than run per session", () => {
    // The registry re-filters every live session against this list every two seconds.
    let scans = 0;
    const list = new CwdAllowlist([], ["/roots"], {
      scan: () => {
        scans += 1;
        return ["/roots/host/owner/one"];
      },
      ttlMs: 60_000,
    });
    list.allows("/roots/host/owner/one");
    list.allows("/roots/host/owner/one");
    list.list(new Map());
    assert.equal(scans, 1);
  });

  void test("no roots means no scan at all", () => {
    let scans = 0;
    const list = new CwdAllowlist(["/workspace/pinned"], [], {
      scan: () => {
        scans += 1;
        return [];
      },
    });
    assert.equal(list.allows("/workspace/pinned"), true);
    assert.equal(scans, 0);
  });

  void test("the refusal offers the clone before the restart, and prices only the restart", () => {
    const { list } = withRoots(["/roots/host/owner/one"]);
    const message = list.refusal("/elsewhere/thing");
    assert.match(message, /Clone it under one of \/roots/);
    assert.match(message, /with no restart/);
    assert.ok(
      message.indexOf("Clone it under") < message.indexOf("AGENTDECK_MOUNTS"),
      "the free way out should come first",
    );
    // The clone is still the free way out and still comes first; the restart is no longer the
    // expensive one it was, so what the message names about it is what it costs NOW.
    assert.match(message, /derived rather than minted/, "the restart is priced with the old cost");
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

  void test("two repositories sharing a basename are told apart by their owner", () => {
    // A root holds one directory per owner, so `dotfiles` twice is ordinary rather than exotic -
    // and two identical rows in the picker is a session started in the wrong tree.
    const roots = new CwdAllowlist([], ["/roots"], {
      scan: () => ["/roots/github.com/alice/dotfiles", "/roots/github.com/bob/dotfiles"],
      ttlMs: 0,
    });
    assert.deepEqual(
      roots.list(new Map()).map((cwd) => cwd.name),
      ["alice/dotfiles", "bob/dotfiles"],
    );
  });

  void test("the returned session arrays are copies", () => {
    // The picker must not be able to mutate the registry's view by editing what it was handed.
    const live = ["a"];
    const [entry] = list.list(new Map([["/workspace/agentdeck", live]]));
    entry?.sessions.push("b");
    assert.deepEqual(live, ["a"]);
  });
});
