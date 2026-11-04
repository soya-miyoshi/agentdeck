# agentdeck

Run coding-agent sessions on your Mac, drive them from your phone.

<p align="center">
  <img src="docs/screenshot-phone.png" alt="agentdeck on a phone: a tab strip, the New session bar, and a live Claude Code session" width="360">
</p>

One tmux session per repository, one tab per session. Each tab shows whether that agent is working,
waiting for you, or has exited, and streams its live terminal output over a WebSocket. No database:
scrollback lives in tmux for as long as tmux does.

## How it works

The server binds loopback only. Tailscale is what carries the phone to it, over your own tailnet
with a real TLS certificate — nothing is exposed to the public internet.

```
   iPhone / iPad                              Your Mac
 ┌───────────────┐                ┌──────────────────────────────────────┐
 │  PWA          │                │  tailscaled                          │
 │  tab strip    │   HTTPS / WSS  │    └─ tailscale serve :443           │
 │  xterm.js     │◀──────────────▶│         └─▶ 127.0.0.1:7777           │
 │  status dots  │    tailnet     │              agentdeck (Go)          │
 │  key row      │    only        │                ├─ creack/pty         │
 └───────────────┘                │                ├─ session registry   │
   bearer token in                │                └─ ring buffer (RAM)  │
   localStorage                   │                       │              │
                                  │              tmux -L agentdeck       │
                                  │                ├─ session: repo-a    │
                                  │                ├─ session: repo-b    │
                                  │                └─ session: repo-c    │
                                  │              one per ghq repository  │
                                  └──────────────────────────────────────┘
```

- The **allowlist** is the set of directories a session may start in. `make start` fills it from
  `ghq root --all`, so every repository you have cloned with ghq is startable and a new clone needs
  no restart.
- A **bearer token** guards every `/api` route and the WebSocket upgrade. It is generated on first
  run and written to `~/.agentdeck/token`, mode 0600, for you to copy to the phone.
- **tmux owns the processes.** Stopping or restarting the server does not stop your agents; the
  restarted server adopts them back.

## Requirements

macOS, and five things: **tmux**, **[ghq](https://github.com/x-motemen/ghq)**,
**[Tailscale](https://tailscale.com/)** (on the Mac and on the phone), **Go 1.23+** for the server,
**Node 22.18+** with **pnpm 9** for the phone client, and at least one agent CLI to run — Claude
Code, Gemini CLI, or just a shell.

Homebrew is the shortest way to tmux and ghq. If you do not have it, install it from
<https://brew.sh> — and put it on your `PATH`, because on Apple Silicon it lands in
`/opt/homebrew/bin`, which is **not** in macOS's default `PATH`:

```sh
eval "$(/opt/homebrew/bin/brew shellenv)"   # in ~/.zshrc; /usr/local on Intel
brew install tmux ghq
```

Tailscale on the Mac should be the **standalone** build from <https://pkgs.tailscale.com/stable/>,
not the Mac App Store one (see [`docs/setup.md`](docs/setup.md#2-tailscale-on-the-mac)).

Node and pnpm are pinned in `mise.toml`, so `mise install` gets the versions this repo is tested
against. mise needs its activation line in the same rc file, or `node` stays whatever macOS has:

```sh
curl https://mise.run | sh
eval "$(mise activate zsh)"                 # in ~/.zshrc, after brew shellenv
mise install                                # node 22, pnpm 9
```

Why each one is there:

- **tmux** — the sessions _are_ tmux sessions, one per repository. The server shells out to `tmux`.
- **ghq** — `make start` fills the allowlist from `ghq root --all`, so every repository you have
  cloned is startable and a new clone needs no restart. Nothing inside the server knows about ghq:
  without it, skip `make` and set `AGENTDECK_MOUNTS` by hand (see [Environment](#environment)).
- **Tailscale** — not optional for phone access. The server listens on `127.0.0.1` and never on a
  LAN address, so the tailnet is the only route in.
- **Go** — the server is one binary, `bin/agentdeck`, built from `server-go/` by `make build` (and
  by every `make` target that runs it). It needs no Node at runtime.
- **Node 22.18+ and pnpm 9** — the phone client is built with Vite (`pnpm build`), and its tests and
  the watchdog run on Node, from TypeScript sources with no build step.

### PATH

Three different processes go looking for these, and they do not share a `PATH`.

**The shell you run `make` in** needs `ghq` and `go`. The Makefile calls `ghq root --all` and
refuses to start rather than boot with an empty allowlist, which is a server that runs fine and can
start nothing.

**The server** needs `tmux`, and needs each agent profile's command. With `tmux` missing the boot
prints its warnings and then fails on `exec: "tmux": executable file not found in $PATH`. An agent command that does not
resolve is not fatal — it is greyed out in the phone's picker as "not on PATH on the Mac; it cannot
be started", checked when the list is served rather than at spawn.

**Every session** gets the server's `PATH`, verbatim. A session's environment is built rather than
inherited — `PATH`, `HOME`, `SHELL`, `TERM`, the locale, `TMPDIR`, `USER`, `LOGNAME`, plus whatever
the profile lists, and nothing else (`baseEnv` in `server-go/tmux.go`). So the `PATH` of the shell you ran
`make start` in is the `PATH` your agents have, and a tool missing there is missing inside every
session on the phone.

`tailscale` is the exception: **it does not have to be on `PATH` at all.**
`scripts/tailscale-serve.mjs` and the watchdog try three absolute locations and never consult
`PATH` — `/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale`, and
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` — with `AGENTDECK_TAILSCALE` overriding all
three. The Mac App Store build only has the third of those; its **Install CLI** menu item is what
creates the second, as a symlink. Typing `tailscale ...` by hand, as [Tailscale](#tailscale) below
does, needs it on `PATH` like anything else.

None of this carries over to `launchd`, if you get as far as installing the watchdog: launchd
expands nothing — no `~`, no login shell — and hands a job a minimal `PATH` with neither Homebrew
nor mise on it. `scripts/com.agentdeck.watchdog.plist` therefore sets `PATH` itself, absolute and
system directories first.

## Setup

[`docs/setup.md`](docs/setup.md) is the same thing as one ordered runbook, from a bare Mac to a
working phone, with how to tell each step worked. The sections below are the reference.

```sh
mise install
pnpm install --frozen-lockfile
pnpm build            # builds the phone client into dist/client
```

**1. Agent profiles.** These decide what command each session runs, so keep the file **outside**
every repository an agent can write. The server refuses to start if it is inside an allowlisted
directory.

```sh
mkdir -p ~/.agentdeck
cp agents.example.json ~/.agentdeck/agents.json
```

```json
{
  "claude": {
    "name": "Claude Code",
    "command": "claude",
    "waiting": { "via": "hook", "settings": "settings.json" }
  },
  "shell": { "name": "Shell", "command": "/bin/zsh" }
}
```

**2. `.env`.** Copy the example and edit it. Node's parser does no expansion, so every path must be
absolute — no `~`, no `$HOME`.

```sh
cp .env.example .env
```

```sh
AGENTDECK_PROFILES=/Users/you/.agentdeck/agents.json
AGENTDECK_ORIGIN=https://your-mac.your-tailnet.ts.net
```

## Tailscale

Two switches are **off by default** in the Tailscale admin console, and both are needed:

- **HTTPS Certificates** — <https://login.tailscale.com/admin/dns>
- **Serve** — for your tailnet

With Serve off, `tailscale serve` **hangs** rather than failing, which reads like a wedged machine
rather than a refusal. With the server already running:

```sh
AGENTDECK_PORT=7777 node scripts/tailscale-serve.mjs
```

That script checks both switches first, applies the proxy, verifies `/api/health` over both loopback
and the `ts.net` URL, and prints the exact `AGENTDECK_ORIGIN=https://<host>.ts.net` line to put in
your `.env`. It exits non-zero on any failure, so a green run is the whole verification.

By hand, the same thing:

```sh
tailscale serve --bg 7777       # run with a timeout: it blocks forever if Serve is off
tailscale serve status          # what is configured, and the https:// URL
tailscale serve reset           # take it down
```

**Never `tailscale funnel`.** That is the public internet, and nothing here is built to survive it.

**The macOS CLI needs `TERM`.** Unset, the standalone build tries to start the GUI and prints
`Tailscale.CLIError` on stdout while exiting 0 — so it reads as unparseable output rather than a
failed command. launchd sets no `TERM`, which is where this bites. Everything here passes it
(`tailscaleEnv` in `src/tailnet.ts`); a wrapper of your own must too.

Give agentdeck its own `ts.net` hostname. The token lives in `localStorage`, which is keyed by
origin, so any other service mounted on the same hostname can read a credential that starts and
kills sessions in every allowed repository.

## Running it

```sh
make start      # foreground, allowlist from `ghq root --all`
make stop       # stops the server, not the agents
make restart    # detached restart; safe to run from inside the deck itself
make up         # start with the watchdog supervising (restarts a crashed server)
make down       # stop the watchdog, then the server
make mounts     # the roots, and what is startable under them right now
```

`make restart` is the one to use **from the phone**: `stop` followed by `start` cannot work there,
because `start` runs in the foreground and stopping the server kills the socket carrying your
keystrokes. Restarting costs a session nothing — tmux holds the agents, and the server adopts them
back. The per-session hook secret comes back too: it is derived, `HMAC(bearer token, session id)`, so
a restarted server recomputes what the running agent already holds, and status detection survives.

Neither `make up` nor the watchdog survives a reboot; installing a launchd job is yours to do. See
[`docs/watchdog.md`](docs/watchdog.md). Once that job **is** installed, do not use `make up`: it
starts a second supervision loop against the same port and the two fight over recovery.

### Getting the token onto the phone

The first run — and any run after you delete `~/.agentdeck/token` — writes a new token to that file
and prints nothing of it. Copy the file's contents to the phone (Universal Clipboard or AirDrop) and
paste it into the app's token field. It travels as the **token alone**, never inside a URL, so it
never lands in browser history or a `Referer` header. The token file must live outside every
repository a session can start in, and the server refuses to start if that path resolves inside an
allowlist entry.

**Do not print the token in a recorded pane.** tmux `capture-pane`, `script`, terminal session
logging and screen recordings all preserve it verbatim. If that happened, treat the token as
disclosed: delete the file, restart, paste the new one everywhere.

There is no expiry and no revocation list. The only way to invalidate a token is to delete the file
and restart, which invalidates it for every device at once.

### Installing to the home screen

Open the `https://<host>.ts.net` URL in **Safari** on iOS (Chrome cannot add to the home screen),
then Share → Add to Home Screen. It launches with no browser chrome. A service worker needs a secure
context, so this only works over the Tailscale HTTPS URL, not over `http://<mac>:7777`.

## Using it from the phone

**You type into the box, not into the terminal.** Everything you write goes into the text area above
the key row and reaches the pty on one submit. Typing straight into xterm cost a network round trip
per character, offered no paste menu, and sent a Japanese IME's half-composed text to the agent.

- **Send** appends CR — what submits a line at a prompt.
- **Insert** sends the text with no CR, for a path or a fragment.
- Newlines inside the box stay LF, so a pasted five-line question is one turn, not five.
- **Copy** puts the pane's text on the clipboard — the selection if there is one, the visible screen
  if not. On a phone this is the only way text leaves that screen, since dragging scrolls the pane.

A soft keyboard has no Escape, Tab, arrows or Ctrl, and those are exactly the keys an agent's
permission prompt is answered with. The **key row** along the bottom sends them as raw bytes.
**Ctrl latches** rather than being held: tap Ctrl, then the next thing sent goes as its control code.
Ctrl, `c`, Send is `0x03`, and it is the way to interrupt an agent.

## Environment

Everything is optional; the row says what leaving it unset means.

| Variable                     | Default                    | Unset means                                                                                                                                     |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTDECK_PORT`             | `7777`                     | Loopback either way; `tailscale serve` decides exposure.                                                                                        |
| `AGENTDECK_PROFILES`         | none                       | No agents, so nothing to start. Must be outside every allowlisted directory.                                                                    |
| `AGENTDECK_ROOTS`            | empty                      | Colon-separated absolute paths scanned for repositories, re-read on every check. `make start` passes `ghq root --all`. The root itself is not startable. |
| `AGENTDECK_MOUNTS`           | empty                      | Colon-separated absolute paths, fixed at boot, exact match and never prefix. With `AGENTDECK_ROOTS` also empty, nothing is startable.           |
| `AGENTDECK_ORIGIN`           | none                       | **The Origin check is off**, so any page your browser visits can drive the socket with a token it holds. Set it to the `https://<host>.ts.net` origin. |
| `AGENTDECK_TOKEN_FILE`       | `~/.agentdeck/token`       | Created 0600 on first run. Never inside an allowlisted directory — the server refuses to start.                                                 |
| `AGENTDECK_AGENT_STATE_DIR`  | `~/.agentdeck/agent-state` | Where hook settings land, for status detection.                                                                                                 |
| `AGENTDECK_TURNS_DIR`        | `~/.agentdeck/turns`       | One 0600 JSONL file per session, in plain text. It outlives the tmux session.                                                                   |
| `AGENTDECK_UPLOAD_DIR`       | `~/.agentdeck/uploads`     | Where images sent from the phone are written, 0600, newest 20 per session.                                                                      |
| `TMUX_SOCKET`                | `agentdeck`                | The `-L` name. Sessions are found on this socket and nowhere else.                                                                              |
| `AGENTDECK_CLIENT_DIR`       | `<repo>/dist/client`       | The built client, served UNAUTHENTICATED. The token and profiles files may not be inside it - the server refuses to start. |
| `AGENTDECK_REPO`             | the binary's `bin/..`      | The checkout whose `tmux.conf` and `dist/client` are used.                                                                       |
| `AGENTDECK_REAP_INTERVAL_MS` | `3600000`                  | How often the server collects abandoned processes. **It kills things.** `0` turns it off; see [Housekeeping](#housekeeping).                    |

A session's environment is **built, not inherited**: a pane gets `PATH`, `HOME`, `SHELL`, `TERM`,
`LANG`, `LC_ALL`, `TMPDIR`, `USER`, `LOGNAME`, plus whatever its profile lists. `SSH_AUTH_SOCK` above
all is left out — a forwarded ssh-agent is `git push --force` to every repository that key reaches.
But `HOME` has to be there, so an interactive shell reading your dotfiles can put it back. Keeping a
credential out of a session means keeping it out of the dotfiles `HOME` points at.

## What you are accepting

**It runs as you, with no sandbox.** An agent that runs `rm -rf ~` or a poisoned `curl | sh` reaches
your home directory, your SSH keys, your browser profiles and every other repository. The allowlist
decides where a session _starts_, not where it can reach. **A git remote is what protects the work.**

That blast radius includes agentdeck's own checkout, and the host then executes parts of it — the
`package.json` scripts, the lockfile, the lint and toolchain config, the tests. Review a diff before
running the toolchain in a checkout an agent has been working in.

**Read [`SECURITY.md`](SECURITY.md) before using this on a machine that matters.** It has the full
list, the review checklist, how the bearer token is handled, and what a separate user account would
and would not fix.

## Housekeeping

Agents leave processes behind — a `nohup`ed build, a polling loop, a tmux server nothing reaped. The
running server collects them hourly and says so on boot. To look before acting:

```sh
make reap        # what is collectable, and nothing happens
make reap-kill   # the same pass, acting
```

Three defaults are worth knowing. A `pnpm dev` whose terminal has closed **is** collected, with its
whole tree (`AGENTDECK_REAP_SPARE_LISTENERS=1` spares it). What a live agent started is collected
too, except MCP servers (`AGENTDECK_REAP_KEEP`); the agent process itself is never touched. Only
agentdeck's own tmux socket is in scope, never your personal one.

Closing a session from the phone ends its whole tree, MCP servers included.

## Non-goals

No file browsing or editing, no git/GitHub integration, no MCP broker or plugin system, no
multi-user access or public exposure, no persistence of terminal output beyond tmux's own lifetime,
and no desktop UI — the desktop already has a terminal.

The dependency budget is spent: the server's two Go modules, `github.com/creack/pty` and
`github.com/coder/websocket`, and the client's three, `vue`, `@xterm/xterm` and `@xterm/addon-fit`.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test   # the client, the watchdog and the repo checks
cd server-go && go vet ./... && go test -race ./...   # the server, against a real tmux
make check                                 # both
make wire                                  # after changing a type in server-go/wire.go
```

The client's types for everything on the wire are generated from the Go server's into
`src/client/wire.gen.ts`, so `tsc` checks the frontend against what the server actually sends.
`go test` fails while that file is stale; `make wire` rewrites it.

For iterating on the client, Vite's dev server proxies `/api` and `/ws` to the server on 7777:

```sh
make start        # one terminal
pnpm dev          # another; the page comes from Vite on 7778
```

`AGENTDECK_ORIGIN` must be unset or set to the Vite origin for that flow, or the server answers 403
to the upgrade and the client reconnects forever instead of saying so.
