# 006 — Staying reachable

The failure that matters: you are away from the desk, you open the phone, and nothing answers.
Everything here is about shortening that window without making it more likely.

## Three different failures, three different answers

**1. The process exits.** Crash, uncaught exception, killed. Nothing brings it back. On the host
there is no supervisor at all — the tmux server keeps every agent alive, so the work survives, but
the phone gets nothing until a person opens a terminal. This used to be the easy one, handled by a
restart policy; de-containerised it is the plainest gap in the design, and the `launchd` agent
below is the whole answer to it.

**2. The process is running but wedged.** Blocked event loop, deadlock, a half-dead process. It is
up and accepting TCP; it just never answers. Nothing detects this either, which is why the health
check below has to prove the event loop turns rather than that a socket accepts.

**3. The host path is broken.** `tailscale serve` not re-established after a reboot, the Mac
asleep, nothing started at login. In practice these are at least as likely as (2), and only
something on the host can fix any of them — which, now that agentdeck is also on the host, is the
same place as everything else.

## The tension, and what de-containerising did to it

An earlier version of this plan was written against a container, where a restart killed tmux and
every session in it, and the whole design of the watchdog followed from how expensive acting
wrongly was.

On the host that cost mostly goes away. tmux is a separate daemon owned by the user; restarting
the Node server does not touch it, and every agent carries on. A false positive costs a socket
reconnect the client is already built to survive (plan 002), not a day of work.

It does not cost nothing, and the difference matters for how readily the watchdog is allowed to
act. The registry holds each session's `cwd`, agent and hook secret in memory only, so sessions
that survive a restart come back with none of them: they are named by their raw id, they drop out
of the per-directory lists `GET /api/cwds` serves,
and every hook POST from a surviving claude session is rejected as unsigned, so that tab never
reports `waiting` again while the session list still advertises `detectsWaiting`. A restart keeps
the work and loses the telling-you-about-it, until the session is recreated. Persisting that
metadata is a known gap, filed alongside `m0/supervisor-crash-test`, and not solved here.

What is left is a **single** rung rather than a ladder: restart the server process. Cheap, and
safe enough to act on weaker evidence than a container restart deserved.

Concretely, on the client that reconnect is a new `epoch`, therefore a snapshot, therefore a
repaint — the path plan 002 specifies and M2's done-criteria test on purpose. This rung is only
as cheap as that path is correct, which is the argument for testing it there rather than
discovering it here.

The one thing that stays expensive is `tmux kill-server`, deliberately or by a reboot: that is
still every session at once, and no watchdog should ever reach for it.

1. The server is down or looks wedged → start it, or restart it in place. Ordinary.
2. Still unhealthy after two restarts → stop and notify. A crash-loop is worse than a server that
   is simply down and known to be down.

Design consequences:

- The health check tests **liveness, not correctness**. Cheap, no dependency on an agent behaving.
- **Consecutive** failures over a meaningful window before acting, not a single miss.
- The restart is **logged and announced**, never silent. It should say that the sessions were
  kept, because a restart notification that does not is one you learn to fear.
- **Backoff and give up**, as step 2 above sets out.

## Health check

`GET /api/health` already exists (plan 002). To be useful it must prove the event loop is
turning, not just that a socket accepts:

- Answer from the same event loop that serves the app — no separate thread or process.
- Include a `tmux list-sessions` round trip, timed out hard. If tmux is unreachable the server
  cannot do its job even though it looks fine.
- Do **not** touch agents, mounts, or the network. A health check that depends on a coding agent
  behaving will produce false positives, and false positives cost sessions.

`scripts/healthcheck.mjs` is that check, run on the host: it does the `tmux list-sessions` round
trip and hits `/api/health`, and requires both. Nothing schedules it yet — it is a command a
person or the watchdog runs, and until the watchdog exists it is the former.

## Reaching it at all: `tailscale serve`, and the two switches that are off

`tailscale serve --bg <port>` in front of the loopback listener is the whole of the phone's path
in. The command is one line. What is not one line is that it depends on **tailnet settings that
are off by default and that the CLI does not name well**, measured on the development Mac on
2026-08-08:

- **Serve is not enabled for the tailnet.** `tailscale serve --bg 7777` prints
  `Serve is not enabled on your tailnet` with an enable link — and then **does not exit**. It
  blocks waiting for someone to click that link, so anything that runs it unattended (a script, a
  `launchd` job, an agent) hangs rather than fails. Never run it without a timeout.
- **HTTPS certificates are not enabled.** Without them there is no certificate for the `ts.net`
  name and the URL cannot be HTTPS at all. `tailscale status --json` reports
  `"CertDomains": null` when they are off, and the machine's names when they are on. That field is
  the only cheap, non-mutating way to tell; `tailscale cert` provisions rather than asks.
- MagicDNS supplies the name itself, `Self.DNSName` in the same JSON (trailing dot included).

Both switches live in the admin console — <https://login.tailscale.com/admin/dns>, under HTTPS
Certificates — and neither the loopback server nor `tailscale serve` can turn them on.

So agentdeck reads that JSON once at boot, with a hard timeout, and **says which of the three
facts is missing in a sentence naming the settings page**. It is the same rule as every other boot
warning here: a protection or a route that is not actually there is stated, never assumed. It is a
report and nothing more — agentdeck does not run `tailscale serve` itself. Exposure stays a
decision a person makes on the host, in one place, exactly as plan 001 has it, and a server that
reconfigured the proxy on every boot would be a second place.

Putting serve in place is still one decision a person makes, and it is now one command:
`scripts/tailscale-serve.mjs`. It is not a second place exposure is decided — it is the operator
running the same `tailscale serve --bg <port>` with the two things a person cannot do by hand
reliably. It reads the JSON above and **refuses before running anything** when either switch is
off, because that is the state in which the command hangs; every call it makes is timed out, and a
hang is reported as the enable link rather than waited on. Having applied the proxy it verifies it
— `serve status` names the port, `/api/health` answers over loopback and over the `ts.net` URL —
and exits non-zero if any of that is untrue, so one green run is the demonstration. Nothing in the
server or the watchdog invokes it.

`AGENTDECK_ORIGIN` is **recommended, not set**. This is the first code that knows what the origin
is (`https://` plus the MagicDNS name without its trailing dot), so the boot warning names that
value rather than a placeholder. It is not applied automatically: setting it would turn the check
on from ambient machine state rather than from the operator's intent, and would 403 the loopback
and Vite flows the same run serves. Naming the exact string is what makes it one paste.

## The watchdog: a `launchd` agent on the Mac

There is one place it can live, and it is the same place everything else now lives. It is the only
thing that can fix failure (3), and — since de-containerising — the only thing that answers
failure (1) at all.

What it does, on a timer (say every 60s):

1. Is the agentdeck server process running? If not, start it. tmux may well still be holding live
   sessions, so this is a reconnection rather than a fresh start.
2. Can the host reach `http://127.0.0.1:<port>/api/health`? If it fails N consecutive checks,
   restart the server, with backoff, a give-up threshold, and a macOS notification via `osascript`
   saying what it did and that the sessions were kept.
3. Is `tailscale serve` still configured for the port? **Built as detect-and-report, not
   re-apply.** The two are told apart: "never configured" is the expected state of an unbuilt
   `m4/tailscale-serve` — reported, and neither a failure of the pass nor a reason to notify —
   while "was configured last pass and is gone now" is the reboot case and does notify. The
   re-apply is left to `m4/tailscale-serve`, which owns the command and is blocked on two admin
   console switches; issuing it from the watchdog would be building that item in the wrong file
   with the switches still off. Once it exists, the watchdog re-applies here, idempotently.

The rule the health branch settled on, which the plan above left as "N consecutive checks":

- **Answered slowly is alive.** `/api/health` includes a hard-timed `tmux list-sessions` round
  trip, so a busy machine or a large capture makes a healthy server slow. An answer at all proves
  the event loop turned, which is the property being tested; latency is not a health verdict. A
  slow 200 is logged as slow and never counts toward a restart.
- **Silent for 15s is wedged** — five times what the server gives its own tmux round trip. Three
  consecutive such passes, three minutes at a 60s interval, before anything is restarted.
- **Refused is down**, and skips the streak: nothing is listening, so there is no socket to drop
  and no snapshot to lose, and waiting three minutes buys nothing.

**A recovery may not hand back a weaker server than the one it replaced.** The watchdog spawns the
server with its own environment, which under launchd is exactly what the plist declares — so
anything the operator exported in the shell they normally start the server from and did not repeat
in the plist is absent from the replacement. Three of those change what the server _is_ rather
than how it is configured: no `AGENTDECK_MOUNTS` is an empty allowlist, no `AGENTDECK_PROFILES` is
nothing startable, and no `AGENTDECK_ORIGIN` is the Origin check off on every `/api` route and
every `/ws` upgrade. The watchdog refuses to start a server without any of them, says so in the
log and once to a person, and stops nothing — a server that is at least configured, however wedged,
beats one replaced by a server that cannot list a session or check an Origin.

Install as a `LaunchAgent` with `RunAtLoad` plus `StartInterval`, and **no `KeepAlive`**: every
deliberate refusal above exits non-zero, and `KeepAlive` would have launchd relaunch each of them
every `ThrottleInterval` — the crash-loop the give-up exists to prevent, one layer below where the
give-up can see it. Logs to a file so a restart is
never something you discover by finding sessions missing.

**It cannot fight a sleeping Mac.** If the lid is shut, nothing runs. `caffeinate`, or the Energy
Saver setting to prevent sleep on power, is the only answer — a decision to make deliberately
rather than discover.

## What separating tmux from the server would have bought

An earlier version of this plan kept an option in reserve: split the tmux server into its own
container so the wedge-prone web server could be restarted without touching the long-lived one.

Running on the host is that separation, for free. tmux is already a daemon of its own, owned by
the user and outliving every run of the Node process, and no volume, socket path or second
container is needed to make it so. The option is recorded as taken rather than as available.

## Milestone placement

M0 ships the health check endpoint and `scripts/healthcheck.mjs`; getting `/api/health` honest is
easier before there is anything else to test.

The `launchd` watchdog belongs at **M4**, alongside the phone work. That is when being unreachable
starts to cost something, and when `tailscale serve` — which the watchdog also supervises — first
exists.
