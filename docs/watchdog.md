# The watchdog

Nothing on macOS supervises the node process. tmux is a daemon of its own, so a crash leaves every
agent alive and the server gone: the work survives, the phone gets nothing, and the recovery is a
person opening a terminal. `scripts/watchdog.mjs` is one supervision pass;
`scripts/com.agentdeck.watchdog.plist` is the LaunchAgent that repeats it every 60 seconds.

`make up` runs the same loop without launchd, for as long as the shell that started it lives.

## One pass

It finds the node process holding the port, probes `http://127.0.0.1:<port>/api/health`, and checks
whether `tailscale serve` is still configured for it.

| It sees                                             | It does                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 200, however slow                                 | Nothing. An answer at all proves the event loop turned, and latency is not a health verdict.                                                             |
| Nothing listening                                   | Starts the server at once. There is no socket to drop and no snapshot to lose.                                                                           |
| Accepted and silent for 15s, or a 503               | Counts it. Three consecutive passes — three minutes — before it restarts anything.                                                                       |
| Still unhealthy after two restarts                  | Stops. Marks the state file `gaveUp` and puts a critical dialog on the screen. A server that is down and known to be down beats one killed every minute. |
| `tailscale serve` configured last pass and gone now | Notifies. That is the reboot case, and it is an outage.                                                                                                  |

The 15-second probe timeout is five times what the server gives its own `tmux list-sessions` round
trip. That gap is the point: a busy machine or a large capture makes a healthy server slow, and
restarting it drops every phone's socket and every tab's snapshot for nothing.

A restart is announced, never silent. State between passes lives in
`~/.agentdeck/watchdog-state.json`; the log is `~/Library/Logs/agentdeck-watchdog.log`, and the
server it starts writes its own output to `~/Library/Logs/agentdeck-server.log`
(`AGENTDECK_SERVER_LOG`) — a separate file, because a server that refuses to boot says why in one
line before it exits.

It cannot fight a sleeping Mac. With the lid shut nothing runs, and Energy Saver or `caffeinate` is
the only answer.

## Installing it

**The repository does not install this** — no package script or task here runs `launchctl`, and
`src/watchdog.test.ts` asserts that. The install is yours, by hand. Read the plist first: check the
node binary, both script paths and the log path against your own checkout, since launchd expands
neither `~` nor `$PATH`.

**Fill in the environment block as well as the paths.** The watchdog spawns the server with its own
environment, so under launchd the plist _is_ the server's environment and nothing exported in your
shell is there. `AGENTDECK_ORIGIN` in particular: absent, the Origin check on every `/api` route and
every `/ws` upgrade is off, so the recovered server is less protected than the one it replaced.
Three things — a source of directories (`AGENTDECK_ROOTS` or `AGENTDECK_MOUNTS`),
`AGENTDECK_PROFILES` and `AGENTDECK_ORIGIN` — are what the watchdog refuses to start a server
without. Add `AGENTDECK_TOKEN_FILE` and `AGENTDECK_AGENT_STATE_DIR` if you moved them off their
defaults. `AGENTDECK_REPO` is already in the plist and has to stay, because `ProgramArguments` names
a copy outside the checkout.

**A `.env` is not part of this.** `make start` loads one; the watchdog spawns `node src/server.ts`
with no `--env-file`, so the plist is the whole environment.

**Installing it makes `scripts/` unattended.** launchd runs `scripts/watchdog.mjs` — a file agents
working here can write — as you, every 60 seconds, with no human action. Everywhere else `scripts/`
is executed by a command a person types after the review in [`SECURITY.md`](../SECURITY.md); a timer
is not. So `ProgramArguments` names a copy outside the checkout and the install step is a `cp` —
which also means **every later change to `scripts/watchdog.mjs` has to be copied across by hand**, or
the timer goes on running the old one.

**The copy buys review scope, not write protection.** Both files launchd executes stay writable by
this uid — `~/.agentdeck/bin/watchdog.mjs` and the mise node named as `ProgramArguments[0]` — so
anything running as you can still rewrite the script and the interpreter, and because the copy lives
outside the checkout that edit is one `git status` and `git diff` cannot see. Only a root-owned
script and a root-owned interpreter would close it, and this repository installs neither. The
watchdog also still spawns `src/server.ts` from the checkout, so a recovery executes agent-writable
code as you either way.

```sh
mkdir -p ~/.agentdeck/bin && cp scripts/watchdog.mjs ~/.agentdeck/bin/watchdog.mjs
cp scripts/com.agentdeck.watchdog.plist ~/Library/LaunchAgents/
# AGENTDECK_ORIGIN is REPLACE_ME in the repository copy on purpose - the tailnet name is your
# machine's, not the project's. Fill it in the INSTALLED copy; the watchdog treats the sentinel
# exactly as it treats an absent value, and refuses to start a server rather than start one with
# the Origin check off.
plutil -replace EnvironmentVariables.AGENTDECK_ORIGIN -string "https://<host>.ts.net" \
  ~/Library/LaunchAgents/com.agentdeck.watchdog.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentdeck.watchdog.plist
launchctl kickstart -p gui/$(id -u)/com.agentdeck.watchdog   # run one pass now
launchctl print gui/$(id -u)/com.agentdeck.watchdog          # is it loaded, what did it exit
tail -f ~/Library/Logs/agentdeck-watchdog.log
```

To take it away again:

```sh
launchctl bootout gui/$(id -u)/com.agentdeck.watchdog
rm ~/Library/LaunchAgents/com.agentdeck.watchdog.plist
```

After it has given up, it stays given up until you say otherwise:
`rm ~/.agentdeck/watchdog-state.json`, then `launchctl kickstart`.

One pass by hand, without launchd:

```sh
AGENTDECK_WATCHDOG_STATE=/tmp/watchdog-state.json node scripts/watchdog.mjs
```
