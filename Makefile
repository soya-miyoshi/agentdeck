# Launch the deck with the cwd allowlist computed from `ghq list -p`, because that list is the one
# thing .env cannot hold: it changes every time a repository is cloned. Everything else - profiles,
# origin, ports - comes from .env, and a variable set here wins over that file.

MOUNTS := $(shell ghq list -p 2>/dev/null | tr '\n' ':')

# The port `stop` looks on: the shell, then .env, then the server's own default.
PORT := $(or $(AGENTDECK_PORT),$(shell sed -n 's/^AGENTDECK_PORT=//p' .env 2>/dev/null),7777)

# Where a detached restart writes what start would have printed to a terminal. Appended, never
# truncated: the boot warnings about the allowlist and the tailnet are the reason to look at it.
LOG := $(or $(AGENTDECK_LOG),$(HOME)/.agentdeck/server.log)

.PHONY: start stop restart mounts check

# Refuses rather than starting with an empty allowlist, which boots fine and then has no directory
# to start a session in - a failure the phone reports as "no directories are allowlisted".
start:
	@test -n "$(MOUNTS)" || { echo "make: 'ghq list -p' returned nothing, so the allowlist would be empty. Is ghq installed?"; exit 1; }
	AGENTDECK_MOUNTS="$(MOUNTS)" node --env-file-if-exists=.env src/server.ts

# Stops the server, not the work: tmux keeps the agents running and a restarted server adopts them
# back. What does not survive is each session's hook secret, so `waiting` detection stays dead for
# every agent that was already running until that agent itself is restarted.
stop:
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
# restarted server adopts them back - measured, not assumed. What does not survive is each
# session's hook secret, so `waiting` detection stays dead for every agent that was already running
# until that agent itself is restarted.
restart:
	@test -n "$(MOUNTS)" || { echo "make: 'ghq list -p' returned nothing, so the allowlist would be empty. Is ghq installed?"; exit 1; }
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
	@AGENTDECK_MOUNTS="$(MOUNTS)" nohup node --env-file-if-exists=.env src/server.ts >> $(LOG) 2>&1 & \
	  echo "make: agentdeck restarting on $(PORT); its output is appended to $(LOG)."

# What start would allowlist, one per line. The phone's tab label is each path's basename.
mounts:
	@ghq list -p

check:
	pnpm typecheck && pnpm lint && pnpm test
