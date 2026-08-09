# Launch the deck with the cwd allowlist computed from `ghq list -p`, because that list is the one
# thing .env cannot hold: it changes every time a repository is cloned. Everything else - profiles,
# origin, ports - comes from .env, and a variable set here wins over that file.

MOUNTS := $(shell ghq list -p 2>/dev/null | tr '\n' ':')

.PHONY: start mounts check

# Refuses rather than starting with an empty allowlist, which boots fine and then has no directory
# to start a session in - a failure the phone reports as "no directories are allowlisted".
start:
	@test -n "$(MOUNTS)" || { echo "make: 'ghq list -p' returned nothing, so the allowlist would be empty. Is ghq installed?"; exit 1; }
	AGENTDECK_MOUNTS="$(MOUNTS)" node --env-file-if-exists=.env src/server.ts

# What start would allowlist, one per line. The phone's tab label is each path's basename.
mounts:
	@ghq list -p

check:
	pnpm typecheck && pnpm lint && pnpm test
