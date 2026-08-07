# 003 — Build order

Each milestone ends at something runnable. Nothing is built before there is a way to see it
work, and nothing lands that is not used by the milestone after it.

## M0 — Skeleton

`mise.toml` (Node 22, pnpm), `package.json`, TypeScript config, lint, and a `GET /api/health`
that answers. CI runs typecheck, lint, and tests from the first commit.

**Not a container** (plan 005 is superseded). agentdeck runs on the Mac directly, as the user, and
every milestone is developed and tested on the host toolchain — `pnpm typecheck`, `pnpm lint`,
`pnpm test`. The server listens on `127.0.0.1` only, which is the one property the earlier
packaging was relied on for that still has to be true. How this is eventually deployed is
deliberately left open; the packaging files are kept on disk unbuilt, and TODO's M0 note says why.

**One minute of Tailscale admin, now rather than at M4.** HTTPS certificates and MagicDNS are off
by default for a tailnet and `tailscale serve` needs both (plan 001). Nothing before M4 uses it,
and M4 is a bad afternoon to find out.

**Nothing supervises Node.** On the host the tmux server is a daemon of its own, so a crash of the
Node process leaves every agent alive — but leaves the server down until a person restarts it.
That is the one thing the discarded PID-1 supervisor did buy, and it is not replaced at M0. It is
answered at M4 by the `launchd` agent (plan 006), and stated here so it is a known gap rather than
an assumption M1 onwards quietly makes.

`src/supervisor-crash.test.ts`, from `m0/supervisor-crash-test`, is that gap made executable: it
SIGKILLs the server process and
asserts what an unattended Mac looks like afterwards. Plainly: **nothing restarts the server.** No
supervisor, no restart loop, no `launchd` plist, no watchdog — every restart in that test is the
test itself starting the process again, standing in for the person who would otherwise have to.
What it pins down beyond "the sessions survive":

- the tmux sessions and their processes survive, same ids and same pane pids
- the registry's `cwd`, agent and per-session hook secret do not — they are memory only. The first
  two are recovered: since `m2/session-metadata-survives-restart` the restarted server **adopts**
  the survivor from tmux, taking its `cwd` from `#{session_path}` and its agent from the id, so
  `GET /api/sessions` lists it again, `GET /api/cwds` counts it, the hub attaches and streams it,
  and the two-agents-in-one-tree warning names it. Adoption is allowlist-checked on
  `#{session_path}` exactly as ordinary listing is, so it is not a way onto the phone for a session
  anywhere else on the socket. (Before that item a survivor was **not listed at all**, and the tab
  stayed blank while the agent worked on.)
- the secret is not recovered and cannot be. Every hook POST from the surviving agent is 401, so
  that tab reports working, idle and exited but never `waiting` again — and recreating the session
  does not fix it. `new-session -A` attaches to the live session and injects no environment, so the
  process keeps the old secret and nothing here can deliver a new one. Only restarting the AGENT
  restores it. An adopted session says so on the wire as `waitingDetectionLost` (plan 002) rather
  than going quiet.

`/api/health` must prove the event loop is turning, not merely that a socket accepts — it does a
hard-timed `tmux list-sessions` round trip and touches nothing else (plan 006).

**CI runs the suite on the runner directly** — typecheck, lint and test, and nothing else. It
builds no artifact, because there is no artifact anything consumes.

Done when: `pnpm start` serves health on host loopback, `scripts/healthcheck.mjs` passes against
it and fails when the server is down, and CI is green on the suite.

## M1 — Sessions, no streaming

The tmux-backed session registry and the HTTP routes. Driven from `curl` only; no client yet.

- `tmux new-session -A` create/reattach, list, kill, with `remain-on-exit on` so a finished agent
  leaves an `exited` session carrying `#{pane_dead_status}` instead of vanishing (plan 002), and
  reaping on `DELETE` or at server start rather than on a timer
- Agent profiles loaded and validated (plan 004); `GET /api/agents`; create takes a profile id,
  never a command line
- `GET /api/cwds`, serving the allowlist with the live sessions in each — the picker cannot be
  built without it, and a phone user typing an absolute path into a soft keyboard is not the
  alternative
- `cwd` allowlist validation on create: a short list of repositories actually worked in, never the
  whole `~/ghq` tree
- `warning` when the cwd already has a live session
- Bearer token generated on first run, `0600`, in an alphabet `Sec-WebSocket-Protocol` accepts —
  unpadded base64url or hex, never padded base64 (plan 001)
- Session ids: `<basename>-<agent>-<hash of absolute path>`, sanitised for tmux's naming rules,
  stable across a server restart because they are a pure function of (path, agent). The agent
  belongs in the key: without it a second create in the same directory silently attaches to the
  agent already there and returns a session whose `agent` field is wrong (plan 002)
- A per-session secret in the spawn environment, ready for the hook route at M3
- The credential decision from plan 005 gets made here: agent API keys in, git push credentials
  out. The agent commits; the human pushes.
- **The allowlist is pre-declared**: the repos actually worked in, named in the server's
  environment rather than discovered. A create for a `cwd` outside it is refused with a sentence
  that says exactly what would have to change, not a generic 403 — this is the refusal a person
  will meet most often, and it has to tell them what to do next.

Done when: creating a session, restarting the server and listing again shows the same session
still running with the same id and the same process, because the restarted server **adopts** it
from tmux (see M0, `m2/session-metadata-survives-restart` and `src/supervisor-crash.test.ts`) —
with the one loss adoption cannot undo, the hook secret, reported as `waitingDetectionLost`; a
session can be started under either the `claude` profile or the
`shell` profile from the same endpoint; **two different agents in one `cwd` produce two sessions
and a `warning`, while the same agent twice hands back the one already running**; and a session
whose command has exited still lists, as `exited`, with its code.

## M2 — One streaming tab

The WebSocket protocol from plan 002, and the smallest client that proves it: one session,
xterm.js, typing works.

- Ring buffer per session — every session, attached or not, because the status field on the list
  response depends on something reading the stream (plan 001)
- `seq` as a cumulative byte count, carried with the `epoch` that says which run of the server it
  counts within, and the two-sided coverage test (plan 002)
- Cold snapshot is `capture-pane` scrollback plus a `refresh-client -R` repaint of the live
  screen, carrying the `seq` the repaint reflects (plan 002)
- `resync` on gap
- WebSocket ping/pong, because a half-open socket is the one disconnection the client cannot
  otherwise detect and shows as a live tab with a frozen status
- Reconnect with backoff, and a rejected token that stops retrying instead of backing off forever
- Pane size is the minimum over attached clients, not the newest attach (plan 002)

Done when: an agent is driven from the browser end to end; the socket is killed mid-output and the
reconnect repaints correctly rather than showing a hole; **the server is restarted under a client
that stays open, and the tab repaints instead of going permanently blank** — the epoch case, which
looks like every other reconnect right up until the screen stays empty; and pulling the network
cable is noticed by the ping before the user notices it by the status not changing.

## M3 — Tabs and status

The actual product. Tab strip, one tab per session, status per tab.

Status inference (plans 001 and 004) gets built here with its spec and captured fixtures. This is
the milestone that can be subtly wrong while looking right — a status that is plausible but stale
is worse than no status, because the tab strip is exactly the thing you glance at instead of
checking.

Build order within the milestone matters: the **agent-agnostic** signals first (exit, output
cadence), so the generic path is the proven one, then the per-agent `waiting` mechanism on top.
An agent with no mechanism must land in a correct, if less informative, state rather than a wrong
one.

The mechanism for `claude` is its **hooks**, not a prompt regex (plan 001 records why, and that
the earlier plan had this wrong). Concretely, this milestone builds:

- `POST /api/hooks/:sessionId` and the per-session secret from M1 that authenticates it
- The settings fragment, merged once and idempotently into the agent-state directory at server
  start — it is one shared file for every session of that agent, so merging per session is
  concurrent writes for an identical result — with the session id and secret injected through the
  environment, which is the part that genuinely varies (plan 004)
- The event mapping: prompt and tool events to `working`, `Stop` and `Notification` to `waiting`.
  An unrecognised `notification_type` *within* `Notification` is actionable; an unrecognised event
  **name** is logged and changes no state. The denylist applies at the layer it was learned at and
  not above it, or the next hook type Claude Code ships lights the strip as "needs you" (plan 004)
- Fixtures captured from real hook payloads, including the informational `Notification` types
  that must NOT raise attention — the case MulmoTerminal had to fix after shipping

Only the `claude` profile ships a mechanism here — not because the design favours it, but because
it is the only agent currently installed and a mechanism must be observed rather than guessed
(plan 004). Every other profile runs on the agent-agnostic path until its CLI is present and can
be driven.

Done when: with three sessions running, the strip correctly distinguishes an agent that is
working from one waiting for input, does so within a second or two of the transition, a session
running the profile-less `shell` agent shows working/idle without ever claiming `waiting`, and a
subagent finishing mid-turn does NOT flag its tab as needing you.

## M4 — Phone

PWA manifest, service worker, `tailscale serve` HTTPS, home-screen install, safe-area layout,
touch targets.

**Plus the key row**, which nothing before this needed because a desktop keyboard has the keys.
Esc, Tab, arrows, Enter and Ctrl are not on a phone, and answering a permission prompt needs all
of them — so without it the phone can watch an agent and not reply to one, which is requirement 6
satisfied and the product missed. Small, but it is the difference between the two.

**Plus getting the token onto the phone**, which nothing before this needed and which has no
obvious place to land otherwise: a QR code printed to the terminal on first run next to the
`ts.net` URL, a paste field in the client for the same string, `localStorage` to hold it, and the
rejected-token path from plan 002 that stops retrying and asks again. Also the
`Sec-WebSocket-Protocol` echo on the upgrade (plan 001) — the socket does not open without it and
the browser says almost nothing about why, so it is worth knowing before an afternoon goes into
it.

**Plus the `launchd` watchdog** (plan 006). It belongs here rather than earlier: being unreachable
only starts to cost something once the phone is the way in, and the watchdog supervises
`tailscale serve`, which does not exist before this milestone. It runs on the host, which is
also the only place that can fix a dropped `serve` config or a Mac that came back from a reboot
with nothing started — and it is what finally supervises the Node process, which nothing does
before this milestone (plan 006).

Restarting the server is not destructive on the host — tmux keeps the sessions — but it is still
only worth doing on evidence, so the watchdog acts after consecutive failures, backs off, gives up
rather than crash-looping, and announces every restart.

Done when: it is installed on the phone, reached over cell (not wifi), **used to answer a real
permission prompt with the key row and not merely to watch one** — and killing the server
process results in an automatic recovery with a notification, with the tmux sessions still alive
afterwards, while a deliberately slow-but-alive server is NOT restarted.

## M5 — Push (optional)

Cloudflare Worker plus VAPID, subscriptions in KV, declared as an `infra` stack.

If it is built, M3 has already done the hard half: what a push should say and when it should fire
is the `waiting` transition, and for `claude` that is the `Notification` hook — an event meaning
"a person is needed here", which is the only thing worth waking a phone for. The remaining work
is delivery, not judgement.

Deferred deliberately: it is the only cloud dependency, the only key to rotate, and the only
part needing infrastructure. Everything before it is useful without it, and it should only be
built if the browser Notification API in M4 turns out to be insufficient in practice.

## Guardrails

Carried from what this session established, so they are decisions rather than habits:

- **Six runtime dependencies or fewer.** An addition needs a line in a plan saying why. The
  premise of this repo is a dependency set that can actually be read.

  Five were spoken for at the point that rule was written: `node-pty`, `ws`, `vue`,
  `@xterm/xterm`, and `@xterm/addon-fit`. Fit is named here rather than discovered at M4 — a
  terminal on a phone has to reflow when the keyboard opens and when the device rotates, that is
  what the addon does, and the alternative is writing the same cell-measuring arithmetic by hand.

  **The sixth is a QR encoder, and this is the line saying why.** M4 gets the token onto the phone
  by printing it as a QR code (plan 001); the alternative is hand-typing a 43-character random
  string into a phone, which is the behaviour that ends with the token in a note. Writing one is
  Reed-Solomon over GF(256) plus a mask-penalty search — a few hundred lines of code whose bugs
  present as a code that will not scan. Take the dependency, take a dependency-free one, and read
  it: the budget rule was always "read what you take", not "take nothing".

  This is the last one. A router or a state library at M3 would breach it, and the answer to both
  is that a tab strip over a session list from the server needs neither. If something later turns
  out to be worth more than the QR encoder, the QR encoder is what it replaces — dropping back to
  the paste field costs a minute per device, once.
- **No emojis anywhere** — code, comments, docs, commit messages, UI.
- **Plans first for anything structural.** These files are the contract; implementations follow
  them, and a needed change edits the plan first.
- **The status module and the wire protocol get tests from the day they are written.** They are
  the two places where being wrong is invisible.
- **Nothing gets vendored from an upstream we do not maintain.** If a dependency is worth
  taking, it is worth reading first.
