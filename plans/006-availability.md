# 006 — Staying reachable

The failure that matters: you are away from the desk, you open the phone, and nothing answers.
Everything here is about shortening that window without making it more likely.

## Three different failures, three different answers

**1. The process exits.** Crash, uncaught exception, OOM kill.
Handled by `restart: unless-stopped` in compose. This is the easy one.

**2. The container is running but wedged.** Blocked event loop, deadlock, a half-dead process
after the OOM killer took a child. The container is "up" and accepting TCP; it just never answers.

**Docker's restart policy does nothing here.** It triggers on exit, not on health. A container can
sit `unhealthy` indefinitely and never be restarted — this is the single most common wrong
assumption about `restart: unless-stopped`, and it is precisely the case being worried about.
Something outside the container has to act.

**3. The host path is broken.** OrbStack not running after a reboot, `tailscale serve` not
re-established, the Mac asleep. No container-level mechanism can fix any of these, and in practice
they are at least as likely as (2).

## The tension: restarting is destructive — but there are two restarts, not one

Plan 005 established that a container restart kills tmux and every session in it.

So an automatic restart is not free. A false positive — a health check that fails during a
legitimately slow moment — destroys running agent work to fix a problem that did not exist. The
watchdog must be **more reluctant than a typical service watchdog**, because the cost of acting
wrongly is higher than the cost of waiting another minute.

**The cheaper move first.** Plan 005 puts an init at PID 1 that owns the tmux server and
supervises the Node process, which means the wedged component can be restarted without touching
the component that holds the work: `docker exec` a signal to the supervisor, Node comes back,
tmux and every agent carry on. A false positive there costs a socket reconnect the client is
already built to survive (plan 002), not a day of work.

Concretely, on the client that reconnect is a new `epoch`, therefore a snapshot, therefore a
repaint — the path plan 002 specifies and M2's done-criteria test on purpose. This rung is only
as cheap as that path is correct, which is the argument for testing it there rather than
discovering it here.

That turns one destructive decision into a ladder:

1. Node looks wedged → restart Node in place. Cheap, and safe enough to try on weaker evidence.
2. Still unhealthy after that → restart the container. Destructive, so it keeps the full
   reluctance below.
3. Still unhealthy after two container restarts → stop and notify. A crash-loop that keeps
   killing sessions is worse than a container that is simply down.

The reluctance below applies to step 2 onwards. Step 1 is allowed to be ordinary.

Design consequences:

- The health check tests **liveness, not correctness**. Cheap, no dependency on an agent behaving.
- **Consecutive** failures over a meaningful window before acting, not a single miss.
- The restart is **logged and announced**, never silent. You need to know sessions were lost —
  and, when it was only step 1, that they were not.
- **Backoff and give up**, as the ladder above sets out.

## Health check

`GET /api/health` already exists (plan 002). To be useful it must prove the event loop is
turning, not just that a socket accepts:

- Answer from the same event loop that serves the app — no separate thread or process.
- Include a `tmux list-sessions` round trip, timed out hard. If tmux is unreachable the server
  cannot do its job even though it looks fine.
- Do **not** touch agents, mounts, or the network. A health check that depends on a coding agent
  behaving will produce false positives, and false positives cost sessions.

```yaml
healthcheck:
  test: ["CMD", "node", "scripts/healthcheck.mjs"]
  interval: 30s
  timeout: 5s
  retries: 4          # ~2 minutes unhealthy before anything acts
  start_period: 30s
```

## The watchdog: on the host, not in a container

The usual answer is a sidecar like `autoheal` that watches for `unhealthy` and restarts. It works,
and it requires mounting `/var/run/docker.sock` into a container — which plan 005 rules out
absolutely, because the socket is root on the host in one command. Restoring uptime by removing
the containment this design exists for is a bad trade.

A socket proxy restricting the API to container restart narrows it, but it is another moving part
that must itself stay healthy.

**Take the simpler path: a `launchd` agent on the Mac.** The host already has Docker access
legitimately, needs no socket mounted anywhere, and — decisively — is the only place that can fix
failure (3). A watchdog inside Docker cannot restart OrbStack or re-establish `tailscale serve`.

What it does, on a timer (say every 60s):

1. Is OrbStack running? If not, start it.
2. Is the container `running` and not `unhealthy`? If unhealthy for N consecutive checks, climb
   the ladder above — Node in place first, the container only if that did not help — with
   backoff, a give-up threshold, and a macOS notification via `osascript` saying which rung it
   reached.
3. Is `tailscale serve` still configured for the port? Re-apply if not; it is idempotent.
4. Can the host reach `http://127.0.0.1:<port>/api/health`? This is the end-to-end check and the
   one that catches things the other three miss.

Install as a `LaunchAgent` with `RunAtLoad` plus `StartInterval`. Logs to a file so a restart is
never something you discover by finding sessions missing.

**It cannot fight a sleeping Mac.** If the lid is shut, nothing runs. `caffeinate`, or the Energy
Saver setting to prevent sleep on power, is the only answer — a decision to make deliberately
rather than discover.

## Optional: make even a container restart non-destructive

Step 1 of the ladder already covers the common case — a wedged Node server, restarted without
touching tmux. What remains uncovered is the container itself dying or being recreated, which is
rarer and mostly deliberate.

If that residue turns out to hurt, there is a way out, at the cost of one more container.

Split the tmux server from the web server. Both containers share a volume holding the tmux socket;
the tmux server lives in a container that is never auto-restarted, while the agentdeck server
lives in one that can be restarted freely. `tmux -S /shared/tmux.sock` from the web container
talks to the server in the other, and agent processes stay in the tmux container's namespace.

That makes the wedge-prone component (a Node server handling sockets) restartable without touching
the long-lived component (tmux and the agents).

**Not in the initial build**, and less attractive than it was before the supervisor at PID 1
existed: it doubles the container count and complicates the mount story to buy the part of the
problem step 1 does not already solve. Written down so the option is remembered rather than
rediscovered — and because the plan-005 warning about `docker compose down` is what makes it
attractive.

## Milestone placement

M0 ships the health check endpoint and the compose `healthcheck` block; getting `/api/health`
honest is easier before there is anything else to test. The supervisor the ladder depends on is
also M0 (plan 005), for reasons that have nothing to do with this plan and everything to do with
crashes not taking the sessions with them.

The `launchd` watchdog belongs at **M4**, alongside the phone work. That is when being unreachable
starts to cost something, and when `tailscale serve` — which the watchdog also supervises — first
exists.
