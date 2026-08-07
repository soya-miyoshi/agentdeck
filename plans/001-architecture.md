# 001 — Architecture

Decisions and the reasoning behind them. Where an alternative was rejected, the reason is
recorded so it does not get re-litigated from scratch later.

## Transport: Tailscale, direct, no relay

The phone reaches the Mac over the tailnet. WebSocket for streams, HTTP for everything else.

`tailscale serve --bg <port>` puts a real Let's Encrypt certificate on the `*.ts.net` name.
That is not only about encryption — it makes the phone a **secure context**, which is the
precondition for installing the PWA, registering a service worker, and using the Notification
API. Over plain `http://100.x.y.z` all three are blocked by the browser, so this is load-bearing
rather than a nicety.

It has a prerequisite that is easy to miss and expensive to miss late: **HTTPS certificates must
be enabled for the tailnet in the admin console**, along with MagicDNS. Both are off by default,
neither is discoverable from the CLI error, and the moment it bites is M4 — the first time the
phone is the way in. Checked at M0 costs a minute.

The server binds loopback and lets `tailscale serve` proxy in, rather than binding the tailnet
address directly. One listener, one place where exposure is decided.

Containerised (plan 005), that becomes: the container publishes its port to `127.0.0.1` on the
host, `tailscaled` stays on the host, and `tailscale serve` proxies to that loopback port. The
container needs no Tailscale, no tailnet identity, and no `--privileged` or `/dev/net/tun`. The
single-place-where-exposure-is-decided property survives intact.

**Rejected: a cloud relay (Firestore command documents), which is what MulmoTerminal does.**
Its purpose is to connect two machines that cannot reach each other. Tailscale already connects
them. Keeping the relay would mean paying a document write, a read, and up to a full poll
interval of latency to move bytes between two hosts with a direct encrypted path already open.

The relay's one genuine advantage is that it works with no VPN — for a phone that cannot join
the tailnet, or someone else's device. That is not a requirement here. If it ever becomes one,
it is an additional transport, not a replacement.

## Session model: node-pty spawning tmux

Each session is `tmux new-session -A -s <name> <command>` under a PTY.

`-A` means attach-if-exists, so the same call starts a session or reattaches to a running one —
a server restart reconnects to living agents instead of orphaning them. This is the property
that makes a laptop lid a non-event, and it is worth the dependency on tmux being installed.

**tmux is also the scrollback store.** `capture-pane -p -e -S -<n>` returns history with ANSI
escapes intact, and it keeps working across restarts of our own process because tmux is a
separate long-lived daemon. This is the single decision that removes the database from the
design.

Sessions are created with **`remain-on-exit on`**. tmux's default is to destroy a session the
moment its command exits, which would mean an agent that finished or crashed removed its own tab
and its exit code with it — leaving the strip unable to distinguish "it is done" from "I lost it",
which is the distinction the strip exists for. Plan 002 has the field and the reaping rule.

**Rejected: node-pty alone, no tmux.** Simpler and one less system dependency, but the agent
dies with the server. For sessions that run for hours unattended, that is the wrong trade.

**Scope of that guarantee, once containerised** (plan 005): tmux and the server both live in the
container, so restarting the Node process still reattaches to living agents — **but only if the
Node process is not PID 1.** With the obvious Dockerfile it is, and then a crash exits the
container, `restart: unless-stopped` recreates it, and tmux dies with every session in it. The
property this whole dependency was taken on for would evaporate precisely where it was meant to
apply, and it would look like it was working right up until the first crash.

So PID 1 is a small init that owns the tmux server and supervises the Node process, and a Node
crash is an in-container event. Specified as M0 work in plan 003 and plan 005; stated here
because it is a precondition of the decision above rather than a packaging detail.

A **container** restart still takes every session with it. The honest claim is "survives a crash
or a redeploy of the app code", not "survives everything", and `docker compose down` is a
destructive act on running work. Keeping tmux on the host instead would punch a hole straight
through the containment, so this is accepted rather than solved.

## Streaming: WebSocket plus a bounded ring buffer

Per session the server keeps a ring buffer of recent output — target 256 KB, tuned once there is
something to measure. On attach the client gets a snapshot, then a live chunk feed.

Every message carries a monotonically increasing `seq`, and an `epoch` that says which run of the
server the counter belongs to. A client that sees a gap asks for a fresh snapshot rather than
silently rendering a hole. This matters on mobile, where the socket drops every time the phone
changes network or the screen sleeps — a reconnect must be unremarkable, not a reload.

Snapshot source: the ring buffer when it covers the client's position, otherwise scrollback from
`capture-pane` followed by a live-screen repaint from `refresh-client -R`. Plan 002 records why
the split — `capture-pane` returns lines rather than terminal state, which is harmless for text
that has already scrolled away and wrong for the screen the agent is still drawing on.

**Rejected: Redis.** It would hold data we have already decided not to keep, needs running and
updating, and duplicates what tmux does for free. "Under a day" is not a retention requirement,
it is permission to have none.

**Rejected: Cloudflare D1 / Firestore for stream storage.** Durable stores for ephemeral data,
billed per operation, and neither can push bytes to a client — a socket would still be needed
on top.

### The server is attached to every session, for the session's lifetime

Not per attached browser client, which is what an earlier draft of this section implied. Two
things force it, and neither is negotiable:

- **`state` is on the session list** (plan 002), so the strip can say which agent needs you
  without opening N streams. That is the entire point of the strip.
- **Output cadence is a property of the byte stream.** Something has to be reading it whether or
  not a phone is looking, or an unwatched session has no status at all — which is the session most
  likely to be the one that needs you.

The costs, stated rather than discovered. Memory is `sessions * ring size`, not `attached tabs *
ring size`: ten repos at 256 KB is 2.5 MB, which is not a consideration. And a session with no
browser client attached still has a pane size — the last one any client asked for, since the
minimum rule in plan 002 is a minimum over *currently attached* clients and an empty set resizes
nothing.

**Rejected: attach on demand, and infer cadence from `#{session_activity}` polling for the rest.**
It saves the buffer of an unwatched session and costs a poll interval of resolution on the one
field the product exists to show, plus a second code path producing the same state by different
means — which is two things to keep agreeing with each other.

## Status inference

The genuinely hard part, and the reason the UI is worth building at all: a tab is only useful
if it tells you which agent needs you.

States: `working`, `waiting`, `idle`, `exited`.

Signals, in order of reliability:

1. **Process exit** — definitive, gives `exited` plus the code.
2. **The agent reporting its own turn boundaries** — a hook it fires, or an event log it already
   writes. Where a CLI offers one, this is the only signal that reliably separates "finished and
   waiting for you" from "thinking quietly", because it is the agent's own statement about itself
   rather than our inference from its pixels.
3. **Output cadence** — bytes written in a recent window. Sustained output is `working`.
4. **Screen shape** — matching the rendered prompt line. The fallback, not the plan; see below.

Signals 1 and 3 are agent-agnostic and work for any command, including a bare shell. Signals 2
and 4 are **per agent** and come from the profile rather than being hardcoded; see
[plan 004](004-agent-profiles.md). An agent with neither still gets a useful tab; it simply never
claims `waiting`. The design degrades to **fewer states, never to a wrong state** — a strip that
is confidently wrong is worse than one that admits it does not know.

### Why the agent's own events, and not the screen

An earlier draft of this plan said MulmoTerminal infers status by matching `❯` / `›` in
`server/session/screen-rows.ts`, and proposed borrowing that technique. That was wrong on the
facts, and the correction changes the design rather than a citation.

`screen-rows.ts` extracts Claude Code's dim ghost-text suggestion so the phone can offer it. The
caret match locates the input box; it does not decide a state. Status there comes from the agent:
`server/session/activity-hook.ts` maps Claude Code's `UserPromptSubmit`, `PreToolUse` and
`PostToolUse` hooks to `working`, and `Stop` and `Notification` to `waiting`, delivered over HTTP
to `server/routes/hook-routes.ts`. Codex, which does not have those hooks, gets a different
mechanism again: `codex-activity-watch.ts` tails the rollout log Codex writes and reads turn
boundaries out of it. Two agents, two mechanisms, neither of them the screen.

The reason is recorded in `server/session/pty-scan.ts`, and it is the strongest single piece of
evidence behind this section:

> The stream is not the screen. A TUI redraws by positioning the cursor between words, so the
> bytes carrying "? for shortcuts" arrive as `?ESC[24GforESC[28Gshortcuts`, and a plain-text
> regex over raw pty data never matches. That is how the draft readiness marker became dead
> code: every claude spawn fell through to the 6-second quiet fallback.

A matcher that silently stops matching, degrades to a timer, and goes unnoticed for months is the
failure this module's spec exists to prevent. It is worse than having no matcher at all, because
the tab strip goes on answering.

Two further hazards, if screen matching is used anyway. Both are stated as things to check
against a captured fixture, not as findings — that is the standard plan 004 sets, and it applies
to this plan's own claims:

- **The caret row is probably not the last non-empty line.** Claude Code draws hint lines below
  its input box — `pty-scan.ts` treats `? for shortcuts` as the box-ready marker, and that
  renders under the caret. MulmoTerminal scans every row for the LAST caret row rather than
  testing the final one, because scrollback holds old prompts above the live one.
- **The caret is probably drawn while the agent is working too**, since input can be queued
  mid-turn. If so, its presence is evidence of an input box and not of a turn having ended, and a
  caret-only rule would report `waiting` almost always.

So, where the screen is used at all: match the rendered screen from `capture-pane`, never the raw
stream; scan rows rather than testing the last one; and treat a caret as necessary but not
sufficient.

### Consequence for the design

`waiting` detection is a per-profile **mechanism** — hook, event log, screen match, or none — not
a per-profile regex. [Plan 004](004-agent-profiles.md) defines the shape, and
[plan 002](002-wire-protocol.md) gains the inbound route the hook mechanism needs.

This module gets its own spec and its own fixtures from the day it is written. Everything above
is one argument for that: it is the piece where being wrong is invisible from the outside.

## Authentication

The tailnet is the boundary; a bearer token is the belt.

A terminal server is remote code execution by design. MulmoTerminal binds loopback for exactly
this reason and has no auth of its own — a decision that is safe only while nothing remote can
connect at all, which stops being true the moment `tailscale serve` is running.

- Token generated on first run, stored `0600`, never logged, never in a query string that could
  land in a proxy log. Sent as `Authorization: Bearer`; on the WebSocket upgrade, via the
  `Sec-WebSocket-Protocol` header rather than the URL. **The server must echo the selected
  subprotocol back in the handshake** or the browser closes the connection — the failure is at
  the socket layer, before any code of ours runs, and it presents as "the socket just will not
  open" with nothing logged.
- **The token is generated in an alphabet that header permits.** Subprotocol values are RFC 7230
  tokens: `/`, `=` and whitespace are illegal, so ordinary padded base64 is rejected at the
  handshake — the same failure, wearing the same disguise, one bullet up. Unpadded base64url or
  hex. Worth writing down because the obvious `randomBytes(32).toString("base64")` is wrong about
  one time in four and right the rest of the time.
- Reject any request whose `Origin` is not the expected `ts.net` host, so a page the phone
  visits cannot drive the socket.
- Never `tailscale funnel`. That publishes to the internet, and nothing in this design is built
  to survive that.

**The page itself is unauthenticated, by necessity.** The token lives in the browser, so the
browser has to load the page before there is a token to send — a bearer check in front of the SPA
would make the paste field unreachable and the token unenterable. So the Node server serves the
built client from `dist/client` on every path that is not an API or socket route: one process,
one port, and the phone's path through `tailscale serve` is the same path dev uses over loopback.
The alternative — `tailscale serve` mounting the static files itself — was rejected because dev
without a tailnet would then need a second mechanism, and the phone would be exercising a route
no one had run.

That surface is an inert asset bundle and is held to it:

- The static handler resolves strictly within the build output directory and rejects anything
  that escapes it. The unauthenticated route serves `dist/client` and never a path on disk.
- Nothing is injected into the HTML — no token, no session list, no cwd allowlist. Every fact
  the client shows arrives from an authenticated `/api` call made after the token is pasted.
- `/api` and `/ws` do not loosen. The `Origin` check above still applies to both; the page being
  reachable without a token does not make the API reachable without one.

**Getting the token onto the phone** is part of the design, not an exercise for the reader. On
first run the server prints the token to the terminal as a QR code alongside the `ts.net` URL;
the PWA has a paste field for the same string. It is held in `localStorage` — a token that has to
be re-entered after every backgrounding is a token that gets pasted into a note instead.
Rotation is deleting the file and restarting, which invalidates every client at once; there is
one token, not one per device, because there is one user. See [plan 002](002-wire-protocol.md)
for what the client does when it is rejected, and plan 003 M4 for where this is built.

## Client

Vue 3 plus `@xterm/xterm`, built by Vite, installed to the home screen as a PWA.

Tabs are client state; the session list comes from the server. Terminal rendering is xterm's
job — writing an ANSI renderer is a category of work with no upside.

Reuse from `mulmoterminal/pwa/`: the layout and interaction patterns, the absent-vs-empty
rendering discipline, and the general shape of the sign-in and error surfaces. Not the
transport — that client speaks Firestore command documents, which this design does not have.

**Reuse there means reading it and writing our own.** Plan 003 forbids vendoring from an upstream
we do not maintain, and a component is not exempt from that because it is ours to paste.

The terminal needs one thing the desktop never did: **a key row.** Esc, Tab, arrows, Enter and
Ctrl are not on a phone keyboard, and answering a permission prompt — the reason this tool exists
— needs all of them. Without it the phone can watch an agent and not reply to one, which satisfies
requirement 6 and misses the point. Built at M4 with the rest of the phone work.

## Push notifications (deferred)

Only needed for alerts while the app is closed. The browser Notification API covers the app
being open, and requires only the HTTPS that `tailscale serve` already provides.

Real push needs an internet-addressable sender: a Cloudflare Worker holding the VAPID keys,
with subscriptions in KV. Free tier, declared as a stack in the `infra` repository.

Deliberately phase 3. It is the only part that adds a cloud dependency, an infra stack, and a
key to rotate, and everything before it is useful without it.
