# Setting it up, start to finish

The ordered procedure, from a Mac with none of this on it to a working deck on your phone. Each
step says how to tell it worked, because most of what goes wrong here fails quietly: a wrong origin
answers `/api/health` with 200 while refusing every browser request, and a `tailscale serve` that
was never applied looks exactly like a server that is down.

Detail lives in [`README.md`](../README.md) and [`watchdog.md`](watchdog.md); this is the order.

## 1. Toolchain

```sh
mise install
pnpm install --frozen-lockfile
pnpm build
```

Verify: `node -v` reports 22.18 or later, and `tmux -V` answers. tmux is not installed by `mise`
here — `brew install tmux` if it is missing.

## 2. Tailscale on the Mac

There are two macOS builds and they are not interchangeable for this. Install the **standalone**
one, from <https://pkgs.tailscale.com/stable/> — not the Mac App Store build.

```sh
curl -LO https://pkgs.tailscale.com/stable/Tailscale-<version>-macos.pkg
sudo installer -pkg Tailscale-<version>-macos.pkg -target /
```

Approve the system extension and the VPN configuration when macOS prompts; both need an
administrator once. Reboot, then launch Tailscale and sign in.

Verify you got the standalone build:

```sh
pgrep -fl io.tailscale.ipn.macsys
```

`macsys` in that name is the standalone build. The App Store build says `macos` instead, sandboxes
its CLI, and is not what the scripts here expect.

**There is no `/Library/LaunchDaemons/com.tailscale.tailscaled.plist`.** The standalone build runs
its daemon inside a system extension, so that file belongs to a third thing — the CLI-only
`tailscaled install-system-daemon` install — and its absence is not a fault.

`tailscale` on `PATH` is a two-line shim the app writes, execing the binary inside the bundle. Both
paths work and `src/tailnet.ts` looks for either.

### The CLI needs `TERM`

The standalone build's CLI tries to start the GUI when `TERM` is unset, and then prints

```
The Tailscale GUI failed to start: ... (Tailscale.CLIError error 3.)
```

**on stdout, exiting 0.** It is not detectable as a failed command, only as unparseable output.
launchd sets no `TERM`, so anything here that shells out to `tailscale` from a launchd job hits it.
Everything in this repository already passes `TERM` for that reason (`tailscaleEnv` in
`src/tailnet.ts`); if you write your own wrapper, do the same.

### Two switches in the admin console

Both are off by default and both are needed:

- **HTTPS Certificates** — <https://login.tailscale.com/admin/dns>
- **Serve** — for your tailnet

With Serve off, `tailscale serve` blocks forever instead of failing, which reads as a wedged machine
rather than a refusal. `scripts/tailscale-serve.mjs` checks both before running anything.

Give agentdeck its own `ts.net` hostname. The token lives in `localStorage`, keyed by origin, so
anything else on that hostname can read a credential that starts sessions in every allowed
repository.

## 3. Profiles and `.env`

```sh
mkdir -p ~/.agentdeck
cp agents.example.json ~/.agentdeck/agents.json
cp .env.example .env
```

Keep `agents.json` **outside** every repository an agent can write — it decides what command each
session runs, and the server refuses to start if it sits inside an allowlisted directory. Node's
`.env` parser expands nothing, so every path is absolute: no `~`, no `$HOME`.

Leave `AGENTDECK_ORIGIN` alone for now. Step 5 prints the correct value.

## 4. Start the server

```sh
make start
```

Verify: `curl -fsS http://127.0.0.1:7777/api/health` returns `{"ok":true,...}`, and `make mounts`
lists the repositories you expect. An empty list means no allowlist, and every session create will
be refused.

## 5. Put Tailscale in front of it

With the server already running:

```sh
AGENTDECK_PORT=7777 node scripts/tailscale-serve.mjs
```

It refuses before changing anything if either switch is off, if Funnel is on for this node, or if
the port is not answering with agentdeck's own health body. Then it applies the proxy and probes the
`ts.net` URL end to end, retrying because the first request to a new name is where the certificate
is issued. A green run is the whole verification.

Its last line prints the exact `AGENTDECK_ORIGIN=https://<host>.ts.net` to put in `.env`. Put it
there and restart, or the Origin check stays off.

**Never `tailscale funnel`.** That is the public internet, and nothing here is built to survive it.

## 6. The phone

Open the `https://<host>.ts.net` URL in **Safari** — Chrome cannot add to the home screen — and
scan the QR code the first run printed to get the token across. Then Share, Add to Home Screen.

**Do the first run somewhere unrecorded.** tmux `capture-pane`, `script`, terminal logging and
screen recordings all preserve the token verbatim.

This step is the only real test. A deck that is green on the Mac and unusable on the phone is the
normal failure here, not the exotic one.

## 7. Optional: the watchdog

[`watchdog.md`](watchdog.md) has the procedure. Two things it is worth knowing before you start:

- The installed job runs a **copy** at `~/.agentdeck/bin/watchdog.mjs`, not the file in the
  checkout. That is deliberate — it keeps an agent's edit to `scripts/` from becoming code a timer
  executes as you within 60 seconds. **Re-copy after every change**, or the timer runs the old one.
- Once it is installed, **do not use `make up`**. That starts a second supervision loop against the
  same port, and the two fight over recovery. `make up` is for the case where no launchd job exists.

Verify: `~/Library/Logs/agentdeck-watchdog.log` gains a line a minute, and after step 5 those lines
say `tailscale serve is configured for the port`. If they say the CLI `did not answer with a serve
status`, that is the `TERM` problem above, not a serve that is actually down.

## What is still true afterwards

The deck runs as you, with no boundary between an agent session and the machine. The `cwd`
allowlist decides where a session *starts*, not where it can reach, and a git remote is what
protects the work. [`README.md`](../README.md#what-you-are-accepting) says what you are accepting in
full; read it before pointing this at anything you care about.
