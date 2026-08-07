#!/bin/sh
# NOT IN USE. agentdeck runs on the Mac directly; nothing builds or runs this file.
# It is kept, not deleted, because how agentdeck is eventually deployed is deliberately left
# open and deleting it would decide that. plans/005-containment.md carries the superseded
# header explaining what the container bought and what its removal cost; TODO.md's M0 note
# says the same in one paragraph. Read both before picking any of this up again.
#
# Supervisor. Not the Node server, and that is the point.
#
# PID 1 is tini, injected by `init: true` in compose, and it does the two things a shell
# cannot do well: reap the zombies agents spawn plenty of, and forward signals. This
# script is tini's only child and owns the two things tini does not know about:
#
#   1. the tmux server, started once and never restarted, because it holds the sessions
#   2. the Node process, restarted in place when it dies
#
# The split is load-bearing rather than tidy (plans 001, 005 and 006). With the obvious
# Dockerfile the Node process is PID 1; then a crash exits the container,
# `restart: unless-stopped` recreates it, and tmux dies with every session in it — the
# exact event tmux was taken on as a dependency to survive. Worse, it tests fine:
# `docker restart`, a redeploy and a manual kill of a child all behave as documented.
# Only a real crash reveals it, at the moment it costs the most.

set -eu

SOCKET="${TMUX_SOCKET:-agentdeck}"
SERVER="${AGENTDECK_SERVER:-/app/dist/server.js}"

# A restart that happens sooner than this after a start is a boot-time crash, not a
# recoverable one. Restarting eagerly through those turns one bug into a loop, which is
# the reluctance plan 005 asks for and plan 006 asks of the host watchdog for the same
# reason.
MIN_HEALTHY_SECONDS=10
MAX_RAPID_FAILURES=5
MAX_BACKOFF_SECONDS=30

log() { echo "agentdeck[init] $*"; }

tmux -L "$SOCKET" start-server
log "tmux server up on socket '$SOCKET'"

child=""
shutdown() {
    log "signal received, shutting down"
    [ -n "$child" ] && kill -TERM "$child" 2>/dev/null || true
    tmux -L "$SOCKET" kill-server 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

if [ ! -f "$SERVER" ]; then
    # Pre-M1: there is no server to supervise yet, and pretending otherwise would make
    # the health check lie. The tmux server is still the useful half — attach to it and
    # the container is already a working, contained place to run an agent.
    log "no server at $SERVER (pre-M1); running as a tmux host only"
    log "attach:  docker compose exec app tmux -L $SOCKET new-session -A -s <name>"
    # Idle rather than exit: exiting would stop the container, and with it a tmux server
    # that may be holding live sessions. "The container is up, the app is not" has to be
    # a state this thing can be in, or the health check has nothing to report.
    while true; do sleep 3600 & child=$!; wait "$child" || true; done
fi

failures=0
while true; do
    started=$(date +%s)

    node "$SERVER" &
    child=$!
    log "server started (pid $child)"

    # `wait` inside the condition, not `wait || true` — the latter throws the exit status
    # away and reports 0 for every crash, which is the one number this line exists to log.
    if wait "$child"; then status=0; else status=$?; fi
    child=""

    ran=$(( $(date +%s) - started ))

    if [ "$ran" -ge "$MIN_HEALTHY_SECONDS" ]; then
        failures=0
    else
        failures=$(( failures + 1 ))
    fi

    log "server exited (status $status) after ${ran}s; consecutive rapid failures: $failures"

    if [ "$failures" -ge "$MAX_RAPID_FAILURES" ]; then
        # Give up restarting, but do NOT exit. Exiting hands the container to
        # `restart: unless-stopped`, which recreates it and takes every tmux session with
        # it — destroying running work to fix a process that was never going to start.
        # Staying up with a dead server is the honest state: the health check reports
        # unhealthy, and the host watchdog (plan 006) decides whether that is worth a
        # restart. That decision belongs outside the container.
        log "giving up after $failures rapid failures; tmux stays up, health check will fail"
        while true; do sleep 3600 & child=$!; wait "$child" || true; done
    fi

    backoff=$(( 1 << failures ))
    [ "$backoff" -gt "$MAX_BACKOFF_SECONDS" ] && backoff=$MAX_BACKOFF_SECONDS
    log "restarting in ${backoff}s"
    sleep "$backoff" & child=$!
    wait "$child" || true
    child=""
done
