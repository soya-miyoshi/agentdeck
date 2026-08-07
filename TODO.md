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

- [x] **`m0/create-500`** - **`POST /api/sessions` answered 500 on a real server run, and left the
      session it had just made.** Found by hand while verifying `m0/supervisor-crash-test`, arrived
      with `m0/host-boundary`, and no unit test caught it because every unit test drives a fake
      tmux.
      **Root cause, measured rather than guessed - and it is NOT what this item first sketched.**
      It was not concurrency, not a chained invocation's stdout reaching the wrong caller, and not
      the `show-environment` sweep. tmux sanitises the output of commands it prints, replacing
      every byte it considers non-printable with `_`, unless the CLIENT's own locale
      (`LC_ALL`/`LC_CTYPE`/`LANG`) says UTF-8. `Tmux.list()` separates its `-F` fields with U+001F,
      and `baseEnv` copied `LANG`/`LC_ALL` only when the launching process had them - so a server
      started under `env -i`, which the reproduction was and which is what launchd hands a job,
      ran every tmux command as a non-UTF-8 client. `list-sessions` came back as
      `id_0__1786113059_/path`, `line.split(SEP)` yielded ONE field, `entry.id` was the whole line,
      `#meta.get(entry.id)` missed, and `Registry.list()` dropped the session. The standalone
      script worked because the shell that ran it had `LANG`. Verified on tmux 3.7b with `od -c`:
      no locale and `LANG=C` give `_`; `LC_CTYPE=UTF-8` and `LC_ALL=C.UTF-8` give the byte intact.
      `capture-pane -p` was checked the same way and is unaffected.
      **Fixed** in `baseEnv` (`LC_CTYPE=UTF-8` defaulted only when no UTF-8 locale is declared, so
      an operator's own locale is kept), with `Tmux.list()` now refusing a separator-less line
      loudly instead of reading it, and `Registry.create` killing a session it created when
      anything after the create fails - so no failure of any kind leaves an orphan. Covered by
      `src/create-500.test.ts`, which drives the real tmux through the real endpoint from a server
      process started with no locale variable at all.

- [x] **`m0/supervisor-crash-test`** — the property M1 onwards depends on, and the one thing the
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
      and the per-session hook secret live only in the registry's memory. Measured by
      `src/supervisor-crash.test.ts` rather than assumed: since `m0/host-boundary` gated
      `Registry.list()` on `#meta` as well as on the cwd allowlist, a session that outlives the
      server is **not listed at all** — not listed under its raw id — so it is absent from
      `GET /api/sessions`, from `GET /api/cwds` and from the two-agents-in-one-tree warning, while
      still running untouched in tmux. Every hook POST from it is rejected as unsigned, and
      recreating the session does not fix that: `new-session -A` attaches to the live session and
      injects no environment, so the process keeps a secret the new registry never minted. It
      never reports `waiting` again until the agent itself is restarted. True of a crash and of
      any deliberate restart (plan 006).

- [x] ~~**`m0/tmux-version`**~~ — MOOT. There is no image shipping 3.3a. The host's tmux 3.7b is
      the one plans 001 and 002 already cite as verified, and `src/tmux.ts`'s error-wording set was
      observed against it.

- [x] **`m0/host-boundary`** — what the container was doing that nothing does now. Filed from
      `m0/de-containerise`'s audit; the twelve findings are in `audit.md` under that heading and are
      the specification. Five are `high` and two were verified by hand on the machine:
      **the `env` name allowlist in plan 004 is not a boundary** — the tmux server inherits whatever
      shell ran `pnpm start`, so a pane sees `SSH_AUTH_SOCK` and every other variable that shell
      had, and an agent with the forwarded ssh-agent can `git push --force` wherever that key
      reaches; and **`tmux show-environment -t <session>` prints `AGENTDECK_SECRET` in full** to any
      process running as the user, while plan 002 documents the leak as `/proc/<pid>/environ`, a
      path macOS does not have. Also here: `Hub.sync()` attaching to anything on the tmux socket
      without consulting the allowlist, `CLAUDE_CONFIG_DIR` falling back onto the operator's live
      Claude config and being rewritten every boot, and the README's `git status --ignored` check
      that reports the directory and never its contents while a test certifies it.
      **This item carries the two decisions `m0/de-containerise` deferred**, because they cannot be
      answered separately: where the token file lives — the default `/var/lib/agentdeck/token` is a
      container-era volume path, and **`pnpm start` fails on a clean host today because of it** —
      and whether the `cwd` allowlist is a boundary or only a check on `POST /api/sessions`.
      **Done when:** a session spawned by agentdeck has an environment built explicitly rather than
      inherited, demonstrated by starting the server from a shell carrying a marker variable and
      showing the pane does not have it; `AGENTDECK_SECRET` is not readable via
      `tmux show-environment`; `pnpm start` works on a clean host with no environment variables set,
      and refuses to start if the token path resolves inside an allowlist entry; plan 002's
      `/proc/<pid>/environ` paragraph names the mechanism this host actually has; and every finding
      in `audit.md`'s `m0/de-containerise` section is marked fixed or accepted-with-a-reason.
      **Settled here, by a person, on 2026-08-07:** the token lives at `~/.agentdeck/token`, created
      0600 on first run, and the server refuses to start if that path resolves inside an allowlist
      entry — the rule made executable rather than written down three times. The `cwd` allowlist
      **is** a boundary: agentdeck lists, attaches to, streams and kills only sessions whose
      directory is on it, and ignores everything else on the tmux socket. The accepted cost is that
      a session started by hand under the agentdeck socket is not a tab. The container's cpu and
      memory bounds and its `~/Library/LaunchAgents` persistence bound were **not** rebuilt; they
      are named as unbounded in plan 005's superseded header, and the resource half belongs to
      `m4/launchd-watchdog`.
      **Found by the audit and fixed before merge, not in the original twelve:** the built
      environment failed open on any tmux server agentdeck did not start — `start-server` is a no-op
      against a live one, and emptying `update-environment` made it worse rather than better because
      tmux's default list names `SSH_AUTH_SOCK` and was overwriting it by accident. `ensureServer`
      now sweeps the server's globals. Six `medium` findings remain open in `audit.md`; three are
      the same-uid residual in different clothes.

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

- [x] **`m2/snapshot`** (audit found the cold-attach path raced its own snapshot — three chunk
      frames arrived ahead of it on a real attach, making every cold attach cost a second full
      snapshot — and that a repaint which collected nothing threw, which an agent can induce
      permanently by attaching extra tmux clients. Both fixed before merge; `Tmux.repaint` still
      refreshes every client tmux lists rather than only ours, which is open in `audit.md`.)
      ORIGINAL: — cold snapshot as `capture-pane` scrollback in `history` plus a
      `refresh-client -R` repaint in `data`, carrying the `seq` the repaint reflects.
      Demonstrated on tmux 3.7b against a session idle since before the attach: `history` held the
      lines that had scrolled off and `data` was the live screen with `seq === headSeq`; with the
      pane on the alternate screen `history` was absent and `data` was the TUI's own frame.
      `refresh-client` takes a CLIENT target, so the session is resolved to its client tty first;
      the end of a repaint is the quiet after it, capped, because tmux puts no marker in the
      stream.
      **Done when:** a client attaching to a long-running session sees scrollback then a correct
      live screen; and in alternate-screen mode `history` is absent rather than wrong.

- [x] **`m2/resync-ping`** — gap detection driving `resync`; server pings every 15s and closes at
      30s without a pong; client reconnects after two silent intervals.
      **Done when:** pulling the network is noticed by the ping before it is noticed by a status
      that stopped changing.
      **Verified against a real half-open socket** — `src/half-open.test.ts` runs a TCP proxy that
      stops forwarding in both directions without closing either side, which is the only failure
      the ping exists for; a close, a destroy or an error all produce events the server already
      reacts to. The test records what the proxy does not model.
      **A per-socket frame budget landed with the automatic retry**, because a reconnect ladder in
      front of an unbounded fire-and-forget message path is the wrong order to build in.
      **Known defect, open in `audit.md`:** the socket's 64 KB `maxPayload` applies to `input`, and
      xterm delivers a paste as one frame — so an ordinary paste of a log closes the transport with
      no error frame, and the client reconnects and re-attaches every tab. Fixing it is a choice
      between an application-layer bound and client-side chunking; the latter wants
      `m2/client-minimal`.

- [x] **`m2/resize-min`** — pane sized to the minimum over _currently attached_ clients; detach
      releases the constraint; an empty set resizes nothing.
      **Done when:** two clients of different sizes attach and the pane matches the smaller; the
      small one detaches and the pane grows.

- [x] **`m2/client-minimal`** — Vue plus `@xterm/xterm` and `addon-fit`, one session, typing works.
      **Done when:** an agent is driven from the browser end to end.
      **Demonstrated by** `src/client/end-to-end.test.ts`: the real client modules against a spawned
      server, the real tmux binary, a real pty and a real `/bin/sh` over a real WebSocket, with the
      two DOM-bound pieces named rather than faked. The manual recipe is in the README.
      **The paste defect carried from `m2/resync-ping` is closed here** by chunking client-side, so
      the client never sends a frame the receiver would refuse.
      **Found by the audit and fixed before merge:** the new input queue outlived the connection it
      was paced for, replaying everything typed during an outage into whatever the agent was doing
      by then. Also two defects in the dev recipe this branch documented — the token shared an
      origin with every Vite project on the machine, and the flow failed silently and forever
      against a server with `AGENTDECK_ORIGIN` set.

- [x] **`m2/session-metadata-survives-restart`** — **done 2026-08-08.** A restarted server now
      **adopts** the sessions tmux still holds: `#{session_path}` is the `cwd`, and the id is
      `sessionId(cwd, agent)`, so the agent is whichever configured profile reproduces the id from
      that path. Nothing is written down - no database, no sidecar file - and the adoption goes
      through the same cwd allowlist, matched on the path TMUX reports, so it widens what may be
      listed and not where. `GET /api/sessions` lists the survivor with the right `cwd` and
      `agent`, `GET /api/cwds` counts it, the hub attaches and streams it, and a client's
      re-attach is answered with a snapshot rather than `no session <id>`.
      **The hook secret is not recovered and cannot be**, and the code refuses to mint a
      replacement it could never deliver (`new-session -A` injects no environment into a live
      session). So an adopted session reports working, idle and exited but **never `waiting`
      again until its own agent is restarted**, and it says so on the wire as
      `waitingDetectionLost` (plan 002) rather than going quietly deaf. Showing that in the strip
      is `m3/tab-strip`'s job, and this item deliberately did not build it.
      Demonstrated against a real server process and real tmux in `src/supervisor-crash.test.ts`,
      including that a session created on the socket outside the allowlist is still not adopted,
      not listed and not killed. Plans 002, 003 and 005, the README and `CwdAllowlist.refusal`
      were all claiming the old behaviour and now state this one.

- [ ] **`m2/reconnect`** (UNBLOCKED on 2026-08-08: `m2/session-metadata-survives-restart` landed,
      so a session that outlives the server is listed and attachable again and the epoch half is
      now reachable. The branch `m2/reconnect` already carries the socket-drop half and telling a
      refused origin from a lost network; it needs `main` merged into it and the epoch half
      finished. Was blocked because after a restart there was no session to re-attach to at all.)
      ORIGINAL: — exponential backoff capped low; a rejected token stops retrying,
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

- [x] **`m2/serve-client`** — nothing serves the built SPA. `src/http.ts` answers `/api/*` and 404s
      everything else. Plan 001's Authentication section now settles who serves it: this server
      does, from `dist/client`, on every path that is not an API or socket route — unauthenticated
      by necessity, since the page has to load before a token exists. Resolve strictly within the
      build directory, inject nothing into the HTML, and leave the `Origin` check on `/api` and
      `/ws` alone.
      **Done when:** opening the `ts.net` URL on a phone loads the client with no token, and the
      first thing it shows is the paste field.
      **Verified by hand against a live server:** encoded traversal is 403, unencoded traversal
      falls through to the SPA fallback rather than serving a file, and symlinks planted inside
      `dist/client` pointing at the bearer token and at a canary outside are both 403. `/api/*`
      still answers JSON. The `ts.net` half waits on `m4/tailscale-serve`; what is demonstrated here
      is the same page over loopback with no token.
      **Found by the audit and fixed before merge:** publishing a directory made it a second place a
      secret must never sit, invisible to the allowlist rule — the server now refuses to start if
      the token or profiles file resolves inside it — and the unbuilt-client 503 was naming the
      absolute build path to unauthenticated callers.

- [x] **`m2/client-visible-heartbeat`** — plan 002 says a client that has seen no traffic for two
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
