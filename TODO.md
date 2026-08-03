# Backlog

One branch per item. Each has a **done when** that is checkable without reading the diff —
if it cannot be demonstrated, it is not done. Milestones follow
[`plans/003-milestones.md`](plans/003-milestones.md); nothing in a milestone starts before the
one above it is green.

Mark an item `[x]` when its branch is merged.

---

## M0 — Skeleton

- [x] **`m0/container`** — Dockerfile, compose, entrypoint supervisor, tmux config, healthcheck
      script. *Done: image builds, `docker inspect` reports healthy, PID 1 is the init and not
      node, mounted repo round-trips file ownership.*

- [x] **`m0/toolchain`** — `package.json`, TypeScript config, lint, formatter, test runner.
      Nothing else; no source files beyond a placeholder.
      **Done when:** `pnpm install && pnpm typecheck && pnpm lint && pnpm test` all pass on an
      empty suite, inside the container.

- [ ] **`m0/ci`** — GitHub Actions running typecheck, lint and test on the runner directly.
      Does **not** build the arm64 image — nothing in CI would run it.
      **Done when:** a PR shows a green check, and a deliberately broken type fails it.

- [ ] **`m0/health-endpoint`** — the smallest HTTP server plus `GET /api/health`, answering
      `{ ok, version }` from the same event loop that will serve the app, with a hard-timed
      `tmux list-sessions` round trip and nothing else. Extend `scripts/healthcheck.mjs` to
      require both halves (its `TODO(M1)`).
      **Done when:** `curl -s 127.0.0.1:7777/api/health` returns ok from the host; the container
      reports healthy; and blocking the event loop with a busy loop makes it report unhealthy
      within the configured window.

- [ ] **`m0/dockerfile-multistage`** — builder stage with `python3`/`make`/`g++`, absent from the
      runtime stage. `node-pty` installs as `prebuild || node-gyp rebuild` and the fallback must
      be able to succeed.
      **Done when:** the image builds with the prebuild path *and* with it forced to fall through
      to `node-gyp`; `require("node-pty")` loads inside the container; and `which g++` fails in
      the runtime stage.

- [ ] **`m0/supervisor-crash-test`** — the property M1 onwards depends on, proven rather than
      assumed. A scripted test that kills the node process inside the container.
      **Done when:** node comes back, the container does **not** restart, and a tmux session
      created beforehand is still alive afterwards with the same id.

- [ ] **`m0/tmux-version`** — the container ships 3.3a, the host 3.7b, and plans 001/002 cite the
      host's as verified. Either pin a newer tmux in the image or re-verify in-container.
      **Done when:** `remain-on-exit` and `window-size` defaults are confirmed against whatever
      tmux the image actually has, and plan 002's verified-on notes name that version.

> Not a branch: **enable HTTPS certificates and MagicDNS in the Tailscale admin console.** One
> minute now, a bad afternoon at M4. Both are off by default and the CLI error does not say so.

---

## M1 — Sessions, no streaming

Driven from `curl` only. No client.

- [ ] **`m1/session-id`** — id as a pure function of (absolute path, agent id):
      `<sanitised-basename>-<agent>-<short-hash>`, obeying tmux's naming rules.
      **Done when:** unit tests cover two checkouts with the same basename under different
      parents (distinct ids), the same path under two agents (distinct ids), and names containing
      `.` and `:` (sanitised, still distinct).

- [ ] **`m1/agent-profiles`** — load and validate `agents.json`, resolve `command` against `PATH`,
      `GET /api/agents` reporting `available` and `detectsWaiting`.
      **Done when:** a profile whose command is missing reports `available: false` rather than
      failing the load; a malformed `waiting` block disables that mechanism and leaves the profile
      startable; and one bad profile does not take down the others.

- [ ] **`m1/tmux-registry`** — `new-session -A` create/reattach, list, kill, with
      `remain-on-exit on`; state from `#{pane_dead}`, code from `#{pane_dead_status}`; reaping on
      `DELETE` or at server start, never on a timer.
      **Done when:** creating a session, restarting the server and listing again shows the same
      session with the same id; and a session whose command has exited still lists as `exited`
      with its code.

- [ ] **`m1/cwds`** — the mount list as the single source for the `cwd` allowlist and
      `GET /api/cwds`, reporting live sessions per directory.
      **Done when:** a `cwd` outside the list is refused with a sentence naming what would have to
      change (a compose edit and a restart), not a generic 403.

- [ ] **`m1/auth-token`** — token generated on first run, stored `0600`, never logged, in an
      alphabet `Sec-WebSocket-Protocol` accepts. Bearer middleware plus `Origin` check.
      **Done when:** 100 generated tokens contain no `/`, `=` or whitespace; a request with no
      token gets 401; and a wrong `Origin` is rejected.

- [ ] **`m1/session-routes`** — `POST`/`DELETE /api/sessions`, taking a profile id and never a
      command line, with the `warning` field.
      **Done when:** two different agents in one `cwd` produce two sessions and a warning, while
      the same agent twice hands back the one already running and says so.

- [ ] **`m1/session-secret`** — a per-session random secret in the spawn environment, ready for
      M3's hook route.
      **Done when:** the secret is present in the session's process environment, differs per
      session, and appears in no response body or log line.

---

## M2 — One streaming tab

- [ ] **`m2/ring-buffer`** — per session, for every session whether attached or not. `seq` as a
      cumulative byte count carried with a per-process random `epoch`.
      **Done when:** unit tests cover the two-sided coverage test
      (`headSeq >= haveSeq >= headSeq - buffer.byteLength`), and a `haveSeq` above `headSeq`
      fails loudly rather than being treated as covered.

- [ ] **`m2/ws-transport`** — one multiplexed socket; token via `Sec-WebSocket-Protocol` with the
      server echoing the selected subprotocol back; `attach`/`detach`/`input`/`resize`.
      **Done when:** a browser opens the socket (proving the echo), and omitting the echo
      reproduces the failure so the test is known to test something.

- [ ] **`m2/snapshot`** — cold snapshot as `capture-pane` scrollback in `history` plus a
      `refresh-client -R` repaint in `data`, carrying the `seq` the repaint reflects.
      **Done when:** a client attaching to a long-running session sees scrollback then a correct
      live screen; and in alternate-screen mode `history` is absent rather than wrong.

- [ ] **`m2/resync-ping`** — gap detection driving `resync`; server pings every 15s and closes at
      30s without a pong; client reconnects after two silent intervals.
      **Done when:** pulling the network is noticed by the ping before it is noticed by a status
      that stopped changing.

- [ ] **`m2/resize-min`** — pane sized to the minimum over *currently attached* clients; detach
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

- [ ] **`m3/status-agnostic`** — process exit and output cadence only. No per-agent mechanism.
      **Done when:** a session running the profile-less `shell` agent reports working/idle/exited
      and **never** claims `waiting`.

- [ ] **`m3/hook-route`** — `POST /api/hooks/:sessionId`, authenticated by the M1 per-session
      secret and explicitly **not** by the user's bearer token.
      **Done when:** a request with the wrong session's secret is rejected, and the user's token
      does not work on this route.

- [ ] **`m3/claude-hook-profile`** — the settings fragment merged once and idempotently at
      container start (not per session), session id and secret injected through the environment;
      event mapping with fixtures captured from real payloads.
      **Done when:** merging twice leaves the file unchanged and preserves keys it did not write;
      an unrecognised `notification_type` **within** `Notification` is actionable while an
      unrecognised event **name** is logged and changes no state; and a fixture of a subagent
      finishing mid-turn does not flag the tab.

- [ ] **`m3/tab-strip`** — one tab per session, status per tab, pushed not polled.
      **Done when:** with three sessions running, the strip distinguishes working from waiting
      within a second or two of the transition.

---

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

- [ ] **`m4/launchd-watchdog`** — host-side, on a timer: OrbStack running, container healthy,
      `tailscale serve` still configured, `/api/health` reachable. Climbs the ladder — node in
      place first, container only if that did not help, then stop and notify.
      **Done when:** killing the container's process group results in automatic recovery with a
      notification, **and a deliberately slow-but-alive server is not restarted.**

---

## M5 — Push (optional)

- [ ] **`m5/push`** — Cloudflare Worker plus VAPID, subscriptions in KV, declared as an `infra`
      stack. Build only if the browser Notification API from M4 proves insufficient in practice.
      **Done when:** a `waiting` transition wakes a phone with the app closed.
