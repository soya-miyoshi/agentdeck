# Working on agentdeck

## Just build the feature

**Do not run the `iterate` skill's pipeline** — the coder/QA/refactor/two-security-rounds/audit
loop — unless Soya says "iteration". It costs about forty minutes per item. Using the app on a real
phone found three defects in twenty minutes against a suite that was 833-green, so the loop is not
where the value is.

The default is: write the code, run the checks, verify it by hand, commit, merge.

```
pnpm typecheck && pnpm lint && pnpm test   # the whole suite is ~40s
```

If something genuinely warrants adversarial review, say so and let Soya decide. Do not start one.

## Keep these, they are cheap and they are why the project is honest

- **Verify, do not infer from green.** A passing suite is a claim about the tests, not the product.
  Run the thing. Most of what has actually been wrong here passed every test at the time.
- **Say what was not demonstrated.** If the phone half could not be shown, the item says so rather
  than implying it. `TODO.md` entries carry that; keep writing them that way.
- **Record open findings in `audit.md`**, one section per piece of work, with what is fixed and what
  is accepted-with-a-reason. It is an append-only ledger, not a record of resolution.
- **Test the property, not the mechanism.** A test that pinned `@touchstart.prevent` locked in a
  bug that made every key-row cap dead on iOS. A test can encode the wrong implementation as
  thoroughly as the right one.
- **A test may not depend on the machine it runs on.** One probed the operator's real `ts.net` name
  and broke the moment the deck was actually deployed.

## Clearing up what sessions leave behind

Agents leave processes running. A `nohup`ed build, a polling loop, a tmux server a killed test never
reaped - they lose their parent, keep their memory, and nothing collects them. 236 abandoned tmux
servers and 525MB had accumulated before anyone looked.

**The running server already does this every hour**, and says so on boot. `make reap` is the same
pass without acting, and is what to look at first.

```
make reap        # what is collectable, and nothing else happens
make reap-kill   # the same pass, acting
```

It collects four things: orphaned process TREES that were working under a root, **everything an
agent started inside a live pane**, tmux servers in the `agentdeck-*` namespace holding no sessions,
and socket files with nothing behind them. `GET /api/processes` and the phone's `Processes` panel
show the third of those before it is collected.

**Run `make reap` when the Mac feels slow.** It is a report: safe to run, safe to suggest.

**Never run `make reap-kill` without showing the operator the `make reap` output first and being
told to go ahead.**

Three things about the defaults, all of them the operator's decision and all of them surprising:

- **A running dev server is collected.** The exemption that spared a tree holding a listening socket
  is off (`AGENTDECK_REAP_SPARE_LISTENERS=1` restores it). A `pnpm dev` whose terminal has closed is
  garbage here, and it goes with its whole tree - turbo, vite, wrangler, esbuild.
- **What a LIVE agent started is collected** - except MCP servers, which the timed pass leaves
  alone. Claude Code does not reconnect a stdio MCP server that dies, so taking one removes a tool
  rather than interrupting it. The pane process itself - the agent - is never touched either.
  `AGENTDECK_REAP_KEEP` is the pattern that spares them; `AGENTDECK_REAP_PANE_CHILDREN=0` limits
  collection to what has actually lost its parent.
- **Only agentdeck's own tmux socket is in scope.** The operator's personal tmux runs on the default
  socket and had five sessions of their own shells on it when this was written. Nothing here may
  reach that, and "everything attached to tmux" would have swept all of it.

**Closing a session on the phone ends its whole tree**, not just the pane, and unlike the timed pass
it does NOT spare MCP servers - a person pressing Close has said they are done with the session. It
is a separate path from the reaper (`Tmux.kill`) and it is where the leftover `python` case is
actually solved.

`make up` runs the deck with the watchdog supervising; `make down` stops the loop and then the
server. Neither survives a reboot, and neither is the right tool now that the LaunchAgent is
installed (above). The root-owned LaunchDaemon of plan 008 is still Soya's to install.

What it still will not collect: anything whose working directory is outside the roots. `ppid 1` with
no controlling terminal describes every launchd daemon on this Mac, and the roots are the only thing
separating them - so an orphan that changed directory elsewhere is missed on purpose.

## Guardrails that are not negotiable

- **Six runtime dependencies, and the budget is SPENT** (`node-pty`, `ws`, `vue`, `@xterm/xterm`,
  `@xterm/addon-fit`, `qrcode-generator`). Any new runtime dependency, or any `package.json` change,
  is a stop-and-ask.
- **No emojis anywhere** — code, comments, docs, commit messages, UI.
- **Comments are one or two lines per function**: what it does and the one non-obvious constraint.
  Long reasoning goes to `audit.md` or a plan, not inline.
- **Host-executed files are stop-and-ask**: `package.json`, `pnpm-lock.yaml`, `eslint.config.*`,
  `.prettierrc*`, `mise.toml`, `mise-tasks/`, `scripts/`, `.claude/`, `.github/workflows/`,
  `.git/config`, `.git/hooks/`, `src/client/public/` (published unauthenticated). Test files under
  `src/**/*.test.ts` are host-executed too but writing them is expected.
- **Commit, do not push.** There is no remote configured. Soya pushes.

## What this thing is, in one paragraph

A terminal server on the Mac, driven from a phone over Tailscale. One tmux session per repo, one tab
per session, streamed over a WebSocket. No database. It runs as you, with no boundary between an
agent session and the machine — the `cwd` allowlist decides where a session _starts_, not where it
can reach, and a git remote is what protects the work. The bearer token starts sessions in every
allowed repository, so it never goes anywhere an agent can read it.

**That last part is decided but not built.** [`plans/008-separate-user.md`](plans/008-separate-user.md)
moves the server to a dedicated non-administrator account started by a root-owned `LaunchDaemon`,
so an agent can no longer reach `sudo`, `/opt/homebrew`, or the operator's home. Nothing has been
installed: today it still runs as you, and every sentence above is the current truth.

## Things that bite

- **The phone is the real test.** It found the dead key row, the missing session picker, and a
  test that depended on the tailnet. Nothing on the Mac finds those.
- **Two tailnet switches** must be on for the phone to reach anything: HTTPS Certificates and Serve,
  both in the Tailscale admin console. `tailscale serve` _hangs_ rather than erroring when Serve is
  off, which reads as a wedge rather than a refusal.
- **The macOS Tailscale CLI needs `TERM`.** Unset, the standalone build tries to start the GUI and
  prints `Tailscale.CLIError` on stdout WITH EXIT 0 - unparseable output, not a failed command.
  launchd sets no `TERM`, which silently blinded the watchdog's serve check for as long as this
  build has been installed. Fixed at the cause in `tailscaleEnv` (`src/tailnet.ts`); any new
  shell-out to `tailscale` must go through it.
- **The tmux prefix is disabled on agentdeck's socket** (`prefix none`), because everything typed on
  the phone reaches a tmux client's key parser — `Ctrl b :` was arbitrary host command execution.
  Attaching to that socket by hand therefore has no tmux bindings.
- **The watchdog IS installed and running**, as a `LaunchAgent` at
  `~/Library/LaunchAgents/com.agentdeck.watchdog.plist`, firing every 60s. It runs the COPY at
  `~/.agentdeck/bin/watchdog.mjs`, so a change to `scripts/watchdog.mjs` reaches the timer only
  after `cp` - re-copy or the timer runs the old one. Plan 008 still makes it a root-owned
  `LaunchDaemon` instead, and drops its `osascript` notification because a daemon-launched account
  has no GUI session to notify; that part is unbuilt.
- **Do not run `make up` while that job is installed.** It starts a SECOND supervision loop against
  the same port and the two fight over recovery. `make up`/`make down` were written for the world
  where no launchd job existed.
- **Same-uid is the standing residual.** Every agent runs as the operator, so the token, the hook
  secrets and the tmux socket are all readable by anything they run. It is recorded, not solved —
  and plan 008 does not solve it either. A separate account moves the residual down one level:
  agents stop sharing a uid with _you_, and go on sharing one with each other.
