# Security model

Read this before pointing agentdeck at a repository you care about. It describes what agentdeck
does not protect, which is most of the machine.

## It runs as you

There is no boundary between an agent session and the Mac. An agent that runs `rm -rf ~` or a
poisoned `curl | sh` reaches the home directory, the SSH keys, the browser profiles and every other
repository. This was a container once, and [`plans/005-containment.md`](plans/005-containment.md) is
kept as the best account of what that bought and what its removal costs. The remaining lever is the
`cwd` allowlist — a short list of the repositories actually worked in — and it decides where a
session _starts_, not where it can reach. **A git remote is what protects the work.**

**Same-uid is the standing residual.** Every agent runs as the operator, so the bearer token, the
per-session hook secrets and the tmux socket are all readable by anything an agent starts. It is
recorded, not solved. [`plans/008-separate-user.md`](plans/008-separate-user.md) moves the server to
a dedicated non-administrator account started by a root-owned `LaunchDaemon`, which would put the
home directory, the SSH keys and the other repositories out of reach — but it is not installed, and
it would not close same-uid either: agents would stop sharing a uid with you and go on sharing one
with each other.

## The bearer token

It lives in `~/.agentdeck/token`, created 0600 on first run; `AGENTDECK_TOKEN_FILE` moves it. The
root of a working tree — where an agent's `ls -la` or `grep -rn token .` meets it — is the one place
it must not be, so **the server refuses to start if that path resolves inside an allowlist entry**.

The token starts sessions in every allowed repository, kills live ones, and attaches to every
agent's terminal. There is no expiry and no revocation list: invalidating it means deleting the file
and restarting, which invalidates it for every device at once.

First run prints it as a QR code carrying **the token alone**, never a URL containing it — a scanned
`?token=…` would leave the credential in browser history, in the `Referer` header of every request
the page makes, and in the log of anything sitting in front of the server.

**That printed block is the credential, so do not do the first run in a pane that is being
recorded.** `capture-pane -p -e` preserves the escape sequences the QR is made of, and agentdeck runs
that on every cold attach; the same goes for `pipe-pane`, `script`, Terminal.app and iTerm2 session
logging, and a screen recording. Starting the server inside tmux is the ordinary way to keep it alive
on a Mac, which is exactly when this bites. agentdeck prints nothing when stdout is not a terminal,
which covers a pipe and a launchd log file, but a TTY that is being recorded is still a TTY. If the
first run happened somewhere that keeps a transcript, treat the token as disclosed: delete the file,
restart, and re-scan on each device.

## The allowlist is a boundary, not a check on one route

agentdeck lists, attaches to and streams the sessions whose directory is on the allowlist, and
ignores everything else on the tmux socket. That socket is `/tmp/tmux-<uid>/agentdeck` and every
process running as you can write it, so without this a
`tmux -L agentdeck new-session -d -c / -- /bin/sh` typed by anything at all becomes a tab your phone
can type into.

Two consequences, both deliberate. A session on that socket becomes a tab iff its directory (the one
tmux reports) is allowlisted **and** its name is exactly the one
agentdeck would derive for that directory and a configured agent. What is excluded is a session
whose name does not match — not a session agentdeck did not start, so a hand-started session under a
matching name **is** listed and typed into. And a repository outside the roots means editing the
allowlist and restarting.

Sessions running at that moment survive a restart in the ways that matter: tmux keeps the processes,
and the restarted server adopts them back. The per-session hook secret comes back too — it is
derived, `HMAC(bearer token, session id)`, so a restarted process recomputes the value the running
agent already holds instead of having to be told it. The residual is that anything holding the token
can compute every session's secret, which the token already implies.

## The agent profiles file

`AGENTDECK_PROFILES` decides what command each session runs: a profile's `command` and `args` go
unmodified into `tmux new-session -- command args` and run as you, so a profile rewritten to
`/bin/sh -c 'curl …|sh'` runs at the next tap of that agent in the picker. It is the most direct
host-execution surface in the system. The server refuses to start when that file resolves inside an
allowlist entry, the same rule the token file gets; keeping it outside every repository is the
supported arrangement.

## A session's environment is built, not inherited

A pane gets `PATH`, `HOME`, `SHELL`, `TERM`, `LANG`, `LC_ALL`, `TMPDIR`, `USER`, `LOGNAME`, plus
whatever names that agent's profile lists in `env`. Nothing else from the shell that started the
server reaches it — `SSH_AUTH_SOCK` above all, since a forwarded ssh-agent is `git push --force` to
every repository that key reaches.

**What that bounds is what a pane INHERITS, not what its own shell puts back.** `HOME` has to be on
the list, so a login or interactive shell reads your dotfiles and re-exports whatever they export. If
`~/.zprofile` sets `SSH_AUTH_SOCK` to the 1Password or `ssh-agent` socket — the setup those tools
document — every shell started under it has the forwarded agent again. The shipped
`agents.example.json` therefore starts `/bin/zsh` with no `-l`, but that only covers the profile we
ship: keeping a credential out of a session means keeping it out of the dotfiles `HOME` points at,
and no server can enforce that.

At boot agentdeck also clears every variable off the tmux server's _global_ environment that is not
on the list above, and logs the names it cleared — because `start-server` does nothing to a socket
that already has a live server, and attaching by hand starts one from your shell.

## The tmux prefix is disabled

`prefix none` on agentdeck's socket, because everything typed on the phone reaches a tmux client's
key parser and `Ctrl b :` was arbitrary host command execution. Attaching to that socket by hand
therefore has no tmux bindings.

## Toolchain

The blast radius includes agentdeck's own checkout, and that is the one whose contents the host then
executes: the `package.json` scripts, `pnpm-lock.yaml` (pnpm 9 runs dependency lifecycle scripts, so
a rewritten resolution entry is host execution at the next install), any lint, format or toolchain
config the host tool discovers for itself — `eslint.config.*`, `.prettierrc*` (prettier imports every
entry of its `plugins` array as JavaScript), `.mise*.toml` and `mise-tasks/` (mise runs `[env]
_.source` and `[tasks]` on the host, and auto-discovers more filenames than the one we happen to
have) — `src/**/*.test.ts` (`pnpm test` hands them to `node --test`, which executes them, and the
suite already shells out), `src/fixtures/` (imported by test files, so `node --test` runs it too even
though the glob above does not match it), `src/client/public/` (Vite copies it verbatim into
`dist/client`, which this server publishes with no bearer token — and that copy dereferences
symlinks, so an entry there becomes a real file holding whatever it pointed at), `.claude/`,
`.github/workflows/`, `.git/config`, `.git/hooks/` and everything under `node_modules` and
`.pnpm-store` are all agent-writable, so running the toolchain runs agent-authored code on the Mac
with your identity.

`.claude/` is the one with no build step in front of it: `.claude/skills/*/SKILL.md`, `CLAUDE.md` and
`.claude/settings.json` are loaded by a Claude Code process running on the Mac, so merely starting an
agent session in this repo is the trigger. `.git/config` and `.git/hooks/` have a weaker trigger
still: `git` itself runs them, so `[core] pager`, an `[alias]` with a `!` prefix or a `textconv` entry
turns the review command into the payload, and a `post-checkout` or `pre-push` hook fires on the
ordinary branch-and-merge workflow with your identity and `~/.ssh` in reach. `.github/workflows/` is
executed by a GitHub runner and declares its own `permissions:`. `node_modules`, `.pnpm-store`,
`.git/config` and `.git/hooks/` are the ones review misses — none of them is tracked, so `git status`
says clean after an agent rewrites `node_modules/.bin/eslint` or `.git/hooks/pre-push`.

```
mise install
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

**Every one of those lines is a review gate, not a convenience.** Each executes files listed above.
`package.json` declares `"postinstall": "node scripts/fix-node-pty-permissions.mjs"`, and pnpm always
runs the root project's own lifecycle scripts, so `pnpm install --frozen-lockfile` executes a file in
this tree whatever the lockfile says. **If you install the LaunchAgent, `scripts/` stops being
triggered only by a person**: launchd then runs `scripts/watchdog.mjs` unattended, as you, every
60 seconds and again after every reboot, so an edit to it is executed within a minute with no human
action and no chance to read a diff — and that same edit chooses the command line the watchdog spawns
as the server. See [`docs/watchdog.md`](docs/watchdog.md). There used to be a container between all
of this and the machine; there is not one now, which makes the review the
only control rather than the second of two.

So before any of those commands, `git status` and `git diff` must be
clean of unreviewed agent edits to `package.json`, `pnpm-lock.yaml`, `eslint.config.*`,
`.prettierrc*`, `.mise*.toml`, `mise-tasks/`, `src/**/*.test.ts`, `src/fixtures/`, `scripts/`,
`.claude/`, `.github/workflows/`, `src/client/public/` and the agent profiles file
`AGENTDECK_PROFILES` points at. **That list is a floor, not the whole job**: the host tools discover
their own config, so the review requires reading every added or modified
file in the diff, not only the named ones.

That review is blind to `node_modules`, `.pnpm-store`, `.git/config` and `.git/hooks/`, which are
untracked, so three more commands belong in the same checklist:

```
rm -rf node_modules .pnpm-store && pnpm install --frozen-lockfile
git config --local --list
ls -la .git/hooks          # anything without a .sample suffix is a live hook
```

The first of those replaces the tree rather than inspecting it, because nothing that reads the tree
can do this job: `git status --ignored` collapses an ignored directory to a single line naming the
directory, so a rewritten `node_modules/.bin/eslint` produces byte-identical output, and
`--ignored=matching` lists all fifty thousand files, which is not a review either.

Run the review itself with git's own execution turned off — `git -c core.pager=cat -c
core.hooksPath=/dev/null status`, and the same for `diff`, `switch` and `merge` — so the command that
inspects the repository is not the command that fires the payload.

## Reporting a vulnerability

Open an issue, or contact the maintainer directly for anything you would rather not file in public.
