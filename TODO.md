# Backlog

One branch per item. Each has a **done when** that is checkable without reading the diff —
if it cannot be demonstrated, it is not done. Milestones follow
[`plans/003-milestones.md`](plans/003-milestones.md); nothing in a milestone starts before the
one above it is green.

Mark an item `[x]` when its branch is merged.

---

## M0 — Skeleton

- [x] ~~**`m0/container`**~~ — MOOT, superseded by `m0/de-containerise`. It was built and it
      worked; agentdeck now runs on the Mac directly and none of it is in the path.

- [x] **`m0/toolchain`** — `package.json`, TypeScript config, lint, formatter, test runner.
      Nothing else; no source files beyond a placeholder.
      **Done when:** `pnpm install && pnpm typecheck && pnpm lint && pnpm test` all pass on an
      empty suite, on the host toolchain.

- [x] **`m0/ci`** — GitHub Actions running typecheck, lint and test on the runner directly.
      Builds no artifact — nothing consumes one.
      **Done when:** a PR shows a green check, and a deliberately broken type fails it.

- [x] **`m0/health-endpoint`** — the smallest HTTP server plus `GET /api/health`, answering
      `{ ok, version }` from the same event loop that will serve the app, with a hard-timed
      `tmux list-sessions` round trip and nothing else. Extend `scripts/healthcheck.mjs` to
      require both halves (its `TODO(M1)`).
      **Done when:** `curl -s 127.0.0.1:7777/api/health` returns ok from the host;
      `scripts/healthcheck.mjs` exits 0 against it and non-zero with the server down; and blocking
      the event loop with a busy loop makes it report unhealthy within the configured window.

- [x] **`m0/de-containerise`** — agentdeck runs on the Mac directly; the container is gone and the
      documents say so. Plans 001/003/004/006, the README, `mise.toml`, the `cwd` refusal and the
      port-clash message no longer describe a container; `scripts/healthcheck.mjs` gained the
      `/api/health` half it was missing and runs on the host; the in-image toolchain test is gone
      rather than left to self-skip. Deliberately not decided here: where the token file lives, and
      whether the `cwd` allowlist is now the only boundary. Both are named as open in plan 005's
      superseded header and are a person's call.

- [x] ~~**`m0/dockerfile-multistage`**~~ — MOOT. There is no image to build, so there is no builder
      stage to keep `g++` out of.

- [ ] **`m0/supervisor-crash-test`** — the property M1 onwards depends on, and the one thing the
      discarded PID 1 supervisor genuinely bought. **Nothing supervises the node process on this
      Mac.** tmux is a daemon of its own, so a crash leaves every agent alive and the server gone:
      the work survives, the phone gets nothing, and the recovery is a person opening a terminal.
      Answering it properly is `m4/launchd-watchdog` (plan 006), which is where `launchd`,
      `tailscale serve` and the notification all land together — so this item is the crash test
      that proves what actually happens meanwhile, not a second supervisor.
      **Done when:** a scripted test kills the node process, and the assertion is that tmux
      sessions created beforehand are still alive with the same ids afterwards and reattach when
      the server is started again — with the plain statement, in the test and in plan 003, that
      nothing restarted it.
      **Known gap, unsolved:** the sessions survive but their metadata does not. `cwd`, `agent`
      and the per-session hook secret live only in the registry's memory, so a session that
      outlives the server comes back named by its raw id, vanishes from `GET /api/cwds` and from
      the two-agents-in-one-tree warning, and has every hook POST rejected as unsigned — it never
      reports `waiting` again. True of a crash and of any deliberate restart (plan 006).

- [x] ~~**`m0/tmux-version`**~~ — MOOT. There is no image shipping 3.3a. The host's tmux 3.7b is
      the one plans 001 and 002 already cite as verified, and `src/tmux.ts`'s error-wording set was
      observed against it.

> Not a branch: **the retained deployment files.** `Dockerfile`, `docker-compose.yml` and
> `docker/` stay on disk, unbuilt and unreferenced by anything that runs. How agentdeck is
> eventually deployed is deliberately left open, and deleting them would decide it. Nothing in
> `plans/`, the README or `src/` describes them as the way this runs — `plans/005-containment.md`
> carries the superseded header explaining what the container bought and what its removal costs,
> and it is the file to read before picking any of this up again. `audit.md` also still names
> them: it is an append-only ledger of what each iteration found, so its entries are a record of
> what was true then, not a claim about now, and rewriting them would be falsifying it.

> Not a branch: **enable HTTPS certificates and MagicDNS in the Tailscale admin console.** One
> minute now, a bad afternoon at M4. Both are off by default and the CLI error does not say so.

---

## M1 — Sessions, no streaming

Driven from `curl` only. No client.

- [x] **`m1/session-id`** — id as a pure function of (absolute path, agent id):
      `<sanitised-basename>-<agent>-<short-hash>`, obeying tmux's naming rules.
      **Done when:** unit tests cover two checkouts with the same basename under different
      parents (distinct ids), the same path under two agents (distinct ids), and names containing
      `.` and `:` (sanitised, still distinct).

- [x] **`m1/agent-profiles`** — load and validate `agents.json`, resolve `command` against `PATH`,
      `GET /api/agents` reporting `available` and `detectsWaiting`.
      **Done when:** a profile whose command is missing reports `available: false` rather than
      failing the load; a malformed `waiting` block disables that mechanism and leaves the profile
      startable; and one bad profile does not take down the others.

- [x] **`m1/tmux-registry`** — `new-session -A` create/reattach, list, kill, with
      `remain-on-exit on`; state from `#{pane_dead}`, code from `#{pane_dead_status}`; reaping on
      `DELETE` or at server start, never on a timer.
      **Done when:** creating a session, restarting the server and listing again shows the same
      session with the same id; and a session whose command has exited still lists as `exited`
      with its code.

- [x] **`m1/cwds`** — one list as the single source for the `cwd` allowlist and `GET /api/cwds`,
      reporting live sessions per directory.
      **Done when:** a `cwd` outside the list is refused with a sentence naming what would have to
      change (`AGENTDECK_MOUNTS` and a restart), not a generic 403.

- [x] **`m1/auth-token`** — token generated on first run, stored `0600`, never logged, in an
      alphabet `Sec-WebSocket-Protocol` accepts. Bearer middleware plus `Origin` check.
      **Done when:** 100 generated tokens contain no `/`, `=` or whitespace; a request with no
      token gets 401; and a wrong `Origin` is rejected.
      **Caveat:** the `Origin` check is present but off until `AGENTDECK_ORIGIN` is set — unset,
      every `/api` request and every `/ws` upgrade is accepted from any origin, and the server
      warns at boot.

- [x] **`m1/session-routes`** — `POST`/`DELETE /api/sessions`, taking a profile id and never a
      command line, with the `warning` field.
      **Done when:** two different agents in one `cwd` produce two sessions and a warning, while
      the same agent twice hands back the one already running and says so.

- [x] **`m1/session-secret`** — a per-session random secret in the spawn environment, ready for
      M3's hook route.
      **Done when:** the secret is present in the session's process environment, differs per
      session, and appears in no response body or log line.

---

## M2 — One streaming tab

- [x] **`m2/ring-buffer`** — per session, for every session whether attached or not. `seq` as a
      cumulative byte count carried with a per-process random `epoch`.
      **Done when:** unit tests cover the two-sided coverage test
      (`headSeq >= haveSeq >= headSeq - buffer.byteLength`), and a `haveSeq` above `headSeq`
      fails loudly rather than being treated as covered.

- [x] **`m2/ws-transport`** — one multiplexed socket; token via `Sec-WebSocket-Protocol` with the
      server echoing the selected subprotocol back; `attach`/`detach`/`input`/`resize`.
      **Done when:** a browser opens the socket (proving the echo), and omitting the echo
      reproduces the failure so the test is known to test something.

- [ ] **`m2/snapshot`** (PARTIAL: `history` from capture-pane works and is tested; `data` is
      currently the ring buffer's contents rather than a `refresh-client -R` repaint, so a first
      attach to a long-idle session shows recent output rather than the live screen. The seq
      arithmetic is already correct for the repaint; only the source is wrong.)
  ORIGINAL: — cold snapshot as `capture-pane` scrollback in `history` plus a
      `refresh-client -R` repaint in `data`, carrying the `seq` the repaint reflects.
      **Done when:** a client attaching to a long-running session sees scrollback then a correct
      live screen; and in alternate-screen mode `history` is absent rather than wrong.

- [ ] **`m2/resync-ping`** (PARTIAL: `resync` is implemented and demonstrated end to end,
      including the stale-epoch case. Ping/pong is implemented on a 15s interval but has NOT been
      verified against a real half-open connection, which is the only failure it exists for.)
  ORIGINAL: — gap detection driving `resync`; server pings every 15s and closes at
      30s without a pong; client reconnects after two silent intervals.
      **Done when:** pulling the network is noticed by the ping before it is noticed by a status
      that stopped changing.

- [x] **`m2/resize-min`** — pane sized to the minimum over *currently attached* clients; detach
      releases the constraint; an empty set resizes nothing.
      **Done when:** two clients of different sizes attach and the pane matches the smaller; the
      small one detaches and the pane grows.

- [ ] **`m2/client-minimal`** — Vue plus `@xterm/xterm` and `addon-fit`, one session, typing works.
      **Done when:** an agent is driven from the browser end to end.

- [ ] **`m2/reconnect`** — exponential backoff capped low; a rejected token stops retrying,
      drops stored state and shows the paste field.
      **Done when:** the socket is killed mid-output and the reconnect repaints instead of showing
      a hole; **and the server is restarted under an open client and the tab repaints rather than
      going permanently blank** — the epoch case, which looks like every other reconnect until the
      screen stays empty.

---

## M3 — Tabs and status

Agent-agnostic signals first, so the generic path is the proven one.

- [x] **`m3/status-agnostic`** — process exit and output cadence only. No per-agent mechanism.
      **Done when:** a session running the profile-less `shell` agent reports working/idle/exited
      and **never** claims `waiting`.

- [x] **`m3/hook-route`** — `POST /api/hooks/:sessionId`, authenticated by the M1 per-session
      secret and explicitly **not** by the user's bearer token.
      **Done when:** a request with the wrong session's secret is rejected, and the user's token
      does not work on this route.

- [x] **`m3/claude-hook-profile`** — the settings fragment merged once and idempotently at
      server start (not per session), session id and secret injected through the environment;
      event mapping with fixtures captured from real payloads.
      **Done when:** merging twice leaves the file unchanged and preserves keys it did not write;
      an unrecognised `notification_type` **within** `Notification` is actionable while an
      unrecognised event **name** is logged and changes no state; and a fixture of a subagent
      finishing mid-turn does not flag the tab.

- [ ] **`m3/tab-strip`** — one tab per session, status per tab, pushed not polled.
      **Done when:** with three sessions running, the strip distinguishes working from waiting
      within a second or two of the transition.

---

## Found while building, not in the original plan

- [ ] **`m2/serve-client`** — nothing serves the built SPA. `src/http.ts` answers `/api/*` and 404s
      everything else. Plan 001's Authentication section now settles who serves it: this server
      does, from `dist/client`, on every path that is not an API or socket route — unauthenticated
      by necessity, since the page has to load before a token exists. Resolve strictly within the
      build directory, inject nothing into the HTML, and leave the `Origin` check on `/api` and
      `/ws` alone.
      **Done when:** opening the `ts.net` URL on a phone loads the client with no token, and the
      first thing it shows is the paste field.

- [ ] **`m2/client-visible-heartbeat`** — plan 002 says a client that has seen no traffic for two
      ping intervals should reconnect, and that is not implementable as written: the server's
      keepalive is WebSocket ping frames, which JavaScript cannot observe. A blind 30-second
      silence timer is worse than nothing, because an idle agent legitimately sends nothing for
      minutes and every idle tab would reconnect in a loop. The half-open connection is exactly
      the case the ping exists for, so this is a real hole rather than a nicety.
      **Done when:** plan 002 gains a client-visible heartbeat (a server-sent `{t:"ping"}`, or
      `state` on a timer), and pulling the network is noticed by the client before it is noticed
      by a status that stopped changing.

## M4 — Phone

- [ ] **`m4/tailscale-serve`** — `tailscale serve --bg` in front of the loopback port.
      **Done when:** the `ts.net` URL loads over HTTPS from the phone and the page reports a
      secure context.

- [ ] **`m4/pwa`** — manifest, service worker, safe-area layout, touch targets.
      **Done when:** it installs to the home screen and launches without browser chrome.

- [ ] **`m4/token-qr`** — QR printed to the terminal on first run beside the URL, paste field in
      the client, `localStorage`, and the rejected-token path from M2 wired to it.
      **Done when:** the token gets onto a phone without being typed by hand, and survives
      backgrounding the app.

- [ ] **`m4/key-row`** — Esc, Tab, arrows, Enter, Ctrl.
      **Done when:** a real permission prompt is **answered** from the phone, not merely watched.

- [ ] **`m4/launchd-watchdog`** — host-side, on a timer: the node process running, `/api/health`
      reachable, `tailscale serve` still configured. Restarts the server after consecutive
      failures, then stops and notifies rather than crash-looping. This is also what finally
      answers `m0/supervisor-crash-test`: nothing supervises node before it.
      **Done when:** killing the node process results in automatic recovery with a notification,
      the tmux sessions still alive with the same ids afterwards, **and a deliberately
      slow-but-alive server is not restarted.**

---

## M5 — Push (optional)

- [ ] **`m5/push`** — Cloudflare Worker plus VAPID, subscriptions in KV, declared as an `infra`
      stack. Build only if the browser Notification API from M4 proves insufficient in practice.
      **Done when:** a `waiting` transition wakes a phone with the app closed.
