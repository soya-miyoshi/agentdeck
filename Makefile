# Launch the deck pointed at `ghq root`, and let the server find the repositories under it on every
# request - a clone made while it runs is startable without a restart. Everything else - profiles,
# origin, ports - comes from .env, and a variable set here wins over that file.

ROOTS := $(shell ghq root --all 2>/dev/null | tr '\n' ':')

# The port `stop` looks on: the shell, then .env, then the server's own default.
PORT := $(or $(AGENTDECK_PORT),$(shell sed -n 's/^AGENTDECK_PORT=//p' .env 2>/dev/null),7777)

# Where a detached restart writes what start would have printed to a terminal. Appended, never
# truncated: the boot warnings about the allowlist and the tailnet are the reason to look at it.
LOG := $(or $(AGENTDECK_LOG),$(HOME)/.agentdeck/server.log)

# Where the supervision loop records itself, so `down` can find it and `up` cannot start a second.
WATCHDOG_PID := $(HOME)/.agentdeck/watchdog-loop.pid
WATCHDOG_LOG := $(or $(AGENTDECK_WATCHDOG_LOG),$(HOME)/Library/Logs/agentdeck-watchdog.log)
# Seconds between passes. The plist uses 60; this matches it so the two behave the same.
WATCHDOG_EVERY := $(or $(AGENTDECK_WATCHDOG_EVERY),60)

.PHONY: start stop restart mounts check reap reap-kill up down

# Refuses rather than starting with an empty allowlist, which boots fine and then has no directory
# to start a session in - a failure the phone reports as "no directories are allowlisted".
start:
	@test -n "$(ROOTS)" || { echo "make: 'ghq root --all' returned nothing, so the allowlist would be empty. Is ghq installed?"; exit 1; }
	AGENTDECK_ROOTS="$(ROOTS)" node --env-file-if-exists=.env src/server.ts

# Stops the server, not the work: tmux keeps the agents running and a restarted server adopts them
# back, hook secret included - it is derived rather than minted, so `waiting` survives a restart.
stop:
	@if [ -f "$(WATCHDOG_PID)" ] && kill -0 "$$(cat $(WATCHDOG_PID))" 2>/dev/null; then \
	  echo "make: the watchdog is supervising (pid $$(cat $(WATCHDOG_PID))). It will START THE SERVER AGAIN within $(WATCHDOG_EVERY)s. Use \`make down\` to stop both."; \
	fi
	@pid=$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN 2>/dev/null); \
	if [ -z "$$pid" ]; then echo "make: nothing is listening on $(PORT)."; exit 0; fi; \
	for p in $$pid; do \
	  cmd=$$(ps -p $$p -o command=); \
	  case "$$cmd" in \
	    *src/server.ts*) kill $$p && echo "make: stopped agentdeck (pid $$p) on $(PORT).";; \
	    *) echo "make: pid $$p on $(PORT) is not agentdeck, refusing to kill it: $$cmd"; exit 1;; \
	  esac; \
	done

# Restart the server and nothing else, from anywhere - including a pane inside the deck itself,
# which is the case `stop` followed by `start` cannot serve: `start` runs in the foreground, so
# typing the two commands from the phone kills the socket carrying the keystrokes before the second
# one is ever read. This one detaches, so the deck comes back and the phone reconnects to it.
#
# The agents are untouched. tmux holds the sessions, this process is only attached to them, and a
# restarted server adopts them back - measured, not assumed - with their hook secret, which is
# derived rather than minted and so survives this process going away.
restart:
	@test -n "$(ROOTS)" || { echo "make: 'ghq root --all' returned nothing, so the allowlist would be empty. Is ghq installed?"; exit 1; }
	@$(MAKE) --no-print-directory stop
	@# The old server closes its listener asynchronously. Starting into a port it still holds is
	@# EADDRINUSE, which leaves NOTHING listening - the failure that reads as "the deck is gone".
	@for i in $$(seq 1 50); do \
	  lsof -ti tcp:$(PORT) -sTCP:LISTEN >/dev/null 2>&1 || break; \
	  sleep 0.1; \
	done
	@if lsof -ti tcp:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "make: something still holds $(PORT) after 5s. Not starting a second server."; exit 1; \
	fi
	@mkdir -p $(dir $(LOG))
	@AGENTDECK_ROOTS="$(ROOTS)" nohup node --env-file-if-exists=.env src/server.ts >> $(LOG) 2>&1 & \
	  echo "make: agentdeck restarting on $(PORT); its output is appended to $(LOG)."

# The roots, then what the server would find under them right now. Kept as `mounts` because that is
# the name in muscle memory; the phone's tab label is each path's basename.
mounts:
	@echo "roots: $(ROOTS)"
	@ghq list -p

# The server WITH the watchdog supervising it, which is what `start` and `restart` do not have.
#
# `scripts/watchdog.mjs` is one pass; launchd is what repeats it, and nothing in this repository may
# run `launchctl` - that install is a person's (plan 006, plan 008, and a test asserts it). So this
# is the no-launchd equivalent: a loop that runs a pass every WATCHDOG_EVERY seconds for as long as
# it lives. It does NOT survive a reboot or a logout, which is exactly what the LaunchDaemon is for.
#
# No separate server start: a pass against a port with nothing on it starts one, so bringing up the
# supervisor brings up the deck, through the same code path that will recover it later.
up:
	@test -n "$(ROOTS)" || { echo "make: 'ghq root --all' returned nothing, so the allowlist would be empty. Is ghq installed?"; exit 1; }
	@if [ -f "$(WATCHDOG_PID)" ] && kill -0 "$$(cat $(WATCHDOG_PID))" 2>/dev/null; then \
	  echo "make: already supervising (pid $$(cat $(WATCHDOG_PID))). \`make down\` stops it."; exit 0; \
	fi
	@test -f .env || echo "make: there is no .env, so the watchdog has no AGENTDECK_PROFILES or AGENTDECK_ORIGIN and will REFUSE to start a server rather than start an emptier one."
	@mkdir -p $(dir $(WATCHDOG_LOG)) $(dir $(WATCHDOG_PID))
	@# .env is sourced into the LOOP, not just into a server: the watchdog spawns `src/server.ts`
	@# itself with no --env-file, so a server it recovers inherits whatever this loop is holding.
	@nohup sh -c 'set -a; [ -f .env ] && . ./.env; set +a; AGENTDECK_ROOTS="$(ROOTS)"; export AGENTDECK_ROOTS; while :; do node "$(CURDIR)/scripts/watchdog.mjs"; sleep $(WATCHDOG_EVERY); done' >> "$(WATCHDOG_LOG)" 2>&1 & \
	  echo $$! > "$(WATCHDOG_PID)"
	@echo "make: supervising every $(WATCHDOG_EVERY)s (pid $$(cat $(WATCHDOG_PID))). Its passes are appended to $(WATCHDOG_LOG)."
	@echo "make: it gives up after two failed recoveries and latches; clear $(HOME)/.agentdeck/watchdog-state.json to resume."

# The loop FIRST, then the server: the other order is the watchdog dutifully restarting the thing
# that was just stopped, which reads as `make stop` being broken.
down:
	@if [ -f "$(WATCHDOG_PID)" ]; then \
	  pid=$$(cat $(WATCHDOG_PID)); \
	  if kill -0 $$pid 2>/dev/null; then kill $$pid && echo "make: stopped supervising (pid $$pid)."; \
	  else echo "make: the recorded supervisor (pid $$pid) was already gone."; fi; \
	  rm -f "$(WATCHDOG_PID)"; \
	else echo "make: nothing was supervising."; fi
	@$(MAKE) --no-print-directory stop

check:
	pnpm typecheck && pnpm lint && pnpm test

# What has been abandoned under the roots: orphaned processes, tmux servers holding no sessions, and
# socket files with nothing behind them. Reports and kills nothing, which is the point - read it
# before running `reap-kill`, because a dev server whose terminal has closed looks like a leftover
# from every angle but one.
reap:
	@test -n "$(ROOTS)" || { echo "make: 'ghq root --all' returned nothing, so the reaper would have no boundary and refuses to run. Is ghq installed?"; exit 1; }
	@AGENTDECK_ROOTS="$(ROOTS)" node scripts/reap.mjs

# The same pass, acting. Kept as a separate target rather than a flag on `reap` so that killing is
# always something typed on purpose.
reap-kill:
	@test -n "$(ROOTS)" || { echo "make: 'ghq root --all' returned nothing, so the reaper would have no boundary and refuses to run. Is ghq installed?"; exit 1; }
	@AGENTDECK_ROOTS="$(ROOTS)" node scripts/reap.mjs --kill
