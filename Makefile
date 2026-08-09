# Launch the deck with the cwd allowlist computed from `ghq list -p`, because that list is the one
# thing .env cannot hold: it changes every time a repository is cloned. Everything else - profiles,
# origin, ports - comes from .env, and a variable set here wins over that file.

MOUNTS := $(shell ghq list -p 2>/dev/null | tr '\n' ':')

# The port `stop` looks on: the shell, then .env, then the server's own default.
PORT := $(or $(AGENTDECK_PORT),$(shell sed -n 's/^AGENTDECK_PORT=//p' .env 2>/dev/null),7777)

.PHONY: start stop mounts check

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

# What start would allowlist, one per line. The phone's tab label is each path's basename.
mounts:
	@ghq list -p

check:
	pnpm typecheck && pnpm lint && pnpm test
