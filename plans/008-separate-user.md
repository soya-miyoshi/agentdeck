# 008 — Running as a separate macOS user

agentdeck runs as a dedicated non-administrator account on the Mac mini, started at boot by a
root-owned `LaunchDaemon`. Nobody logs into that account. The operator uses the machine as
themselves, in a different session, at the same time.

This plan replaces the deployment question plan 005 left open, and rewrites the watchdog half of
plan 006.

## The threat being answered, stated narrowly

**Administrator rights on the Mac.** Not confidentiality of the source, not the agents reaching
each other, not the network. An agent that runs a poisoned `curl | sh`, or `rm -rf`, or edits a
file the human later executes, must not end up able to `sudo`, install a system daemon, or modify
the machine.

Naming it that narrowly is what makes this plan cheap. Plan 005's container and the VM considered
alongside it were both answers to a wider question, and both cost a second toolchain, a second
checkout and a synchronisation story. A standard user answers the narrow question with account
separation macOS already enforces, and costs one `dscl` invocation and a plist.

**What is deliberately not claimed:** this is not a sandbox. A standard user is a boundary against
escalation, not against a determined exploit — see _What this does not buy_ below.

## What a standard user actually gets, measured

Measured on the development Mac (macOS 26.5.2) on 2026-08-09. These are macOS defaults rather
than local configuration, but they are defaults, not guarantees, and the Mac mini gets the same
commands run against it before anything is believed.

- **`sudo` is unavailable.** `dscl . -read /Groups/admin GroupMembership` returns `root soya
  _mbsetupuser`. An account absent from that list has no path to root through `sudo`, cannot write
  `/Library/LaunchDaemons`, and cannot change system settings.
- **Homebrew is readable and not writable.** `/opt/homebrew` is `drwxr-xr-x soya:admin` and
  `/opt/homebrew/bin` is `drwxrwxr-x soya:admin` — group-writable by `admin`, which the agent
  account is not in. So the agent executes `tmux`, `git` and `node` from there and cannot tamper
  with binaries the operator later runs. Trust flows in the correct direction, and it is the
  reason the agent account should get its toolchain from `/opt/homebrew` rather than only from
  its own `mise`.
- **The operator's secrets are already mode-protected.** `~/.ssh/id_ed25519`, `~/.claude.json` and
  `~/.claude/.credentials.json` are all `0600`. Another account in `staff` cannot read them.
- **The tmux socket directory is private.** `/tmp/tmux-501` is `drwx------`, so the operator's own
  tmux — and agentdeck's socket, whichever account owns it — is not reachable across accounts.

### The one hole that is open by default, and the one command that closes it

`/Users/you` is `drwxr-x---+ you:staff` (the ACL is a single `group:everyone deny delete`), and
**every local macOS account has `staff` as its primary group**. So a newly created standard user
can traverse the operator's home and read everything inside it that is group-readable — which
includes `~/ghq` at `0755`, every checkout under it, and `~/.claude` at `0755` with the
per-project transcripts under it. The `0600` files above stay unreadable; the source code and the
conversation history do not.

```
sudo chmod 700 /Users/you
```

This is a required step of the install, not a hardening suggestion. Without it the agent account
can read the operator's work, which is most of what the separation was for even under the narrow
threat model above.

Two smaller ones, recorded rather than fixed:

- **`/Users/Shared` is `drwxrwxrwt`.** Anything either account puts there is writable by the
  other. Nothing in this design may use it.
- **`ps` shows every account's command lines.** Not memory — `task_for_pid` across users needs
  root — but arguments are visible both ways. agentdeck passes secrets by environment and by file
  (plan 004, plan 001), never on a command line, and that now has a second reason to stay true.

## Why a `LaunchDaemon` and not a login session

The obvious way to run something as another user is to log that user in and use fast user
switching. It works — switching users leaves the other session's processes running — but it makes
availability depend on a GUI session that a logout or a reboot ends, and it is the operator who
would have to notice and log the account back in. That is failure (3) from plan 006 with an extra
step in it.

Instead: a **root-owned plist in `/Library/LaunchDaemons`, with `UserName` set to the agent
account**. It starts at boot with no login, survives the operator logging in and out, and needs
nothing from fast user switching. The operator uses the Mac normally and the deck is simply up.

This also closes something plan 005's superseded header names as open and unbuilt:

> Only a root-owned script and a root-owned interpreter would close it, and that is not built.

Under a `LaunchDaemon` both are available for the first time. The plist, the watchdog script
copied beside it, and the interpreter are all owned by `root` or by `admin`, and the agent account
— which is the account every agent runs in — cannot write any of them. The rewrite of plan 006's
install section is therefore not cosmetic: the watchdog stops being a file the thing it supervises
can edit.

**The interpreter needs a decision.** `/opt/homebrew/bin/node` is `26.4.0` and admin-owned;
`mise` gives this repo `22`, in the agent's own home, where the agent can rewrite it. Pointing
`ProgramArguments[0]` at the agent's `mise` node throws the property away. The plan takes:
`brew install node@22` as the operator, and `ProgramArguments[0]` =
`/opt/homebrew/opt/node@22/bin/node`. Pinned, and not writable by the account it supervises. If
that formula is ever unavailable, a root-owned copy under `/usr/local/agentdeck/bin` is the
fallback; what may not happen is the daemon running the agent's own node.

### What having no GUI session costs

Three things break, and each has an answer rather than a workaround:

- **No login keychain.** It is not unlocked for a daemon-launched account, so anything reaching
  for it fails: git's `osxkeychain` credential helper, in particular. Answer: SSH deploy keys for
  git, and file-based agent credentials — `~/.claude/.credentials.json` is a real file at `0600`
  on this machine and is what the container era already relied on (plan 005's agent-state mount).
- **`osascript` notifications do not work.** Plan 006 has the watchdog announce a restart with
  `osascript -e 'display notification'`. There is no Aqua session for the agent account, so that
  call fails, and a notification aimed at a session nobody is looking at would be useless even if
  it succeeded. Answer: **the watchdog's announcement is the log file and nothing else**, and the
  give-up case is what the operator must be told about. Reaching the operator's session from the
  daemon would mean `launchctl asuser <uid> ...` as root, which is a root-privileged call made on
  a schedule to run something in the human's session — the exact shape this plan exists to remove.
  It is refused, and the notification comes back by inverting the direction instead. See
  _Monitoring, split in two_.
- **Tailscale.app is per-user and cannot run there.** Addressed below, where it turns out to be an
  improvement.

## Exposure stays with the operator

`tailscale serve` is configured **once, by the operator, in their own account**, pointed at
`127.0.0.1:<port>`. The agent account listens on loopback and has no Tailscale of its own, no
`serve` configuration it can change, and no way to publish anything else on the tailnet.

Plan 001 says exposure is decided on the host in one place. Under a single account that was a
convention the server chose to honour; here it is enforced by the account boundary, which is
strictly better than what the container had.

Consequences to accept, not to fix:

- **`src/tailnet.ts` will read nothing.** `tailscale status --json` goes through a local API
  socket the agent account is not the operator of, so `readTailnet` returns `undefined` — the
  branch it already has for every failure alike. The boot report loses its tailnet sentences. That
  is honest: the account genuinely cannot see the tailnet, and the report saying so beats it
  guessing. `AGENTDECK_ORIGIN` therefore has to be set in the plist by hand, and with the boot
  warning silent nothing will remind anyone — so the plist carrying it is a done-when below rather
  than a nicety.
- **`scripts/tailscale-serve.mjs` is an operator command, run in the operator's account.** It was
  already specified as something no server or watchdog invokes (plan 006); now it is also
  something the agent account could not run if it tried.
- Loopback is machine-wide, so any account on the Mac mini can reach the port. The bearer token is
  what protects it, exactly as before. Nothing changes here; it is stated so nobody reads the
  account split as a network boundary.

## Monitoring, split in two

Plan 006 treats the watchdog as one thing. Across an account boundary it is two, because `kill`
and `spawn` do not cross accounts and `curl` does.

**Telling the operator: the operator's own account, no privilege at all.** A `LaunchAgent` in the
operator's login session, on the same interval, that reads `/api/health` over loopback and reads
the daemon's log. It needs no root, no `sudo` and no `launchctl asuser`, and because it runs in a
real GUI session its `osascript` notification works. This is the refused push inverted into a
pull: the privileged side never reaches into the human's session; the human's session goes and
looks. It is also the only half that has to survive the server being unreachable, which is why it
must not be a feature of the server.

The cost is one deliberate permission: **the daemon's log has to be readable by `staff`** so the
operator's agent can read it. That is the opposite direction from `chmod 700 /Users/<operator>`
and it is safe in a way the reverse is not — the log is output, not input, and nothing consumes it
but a human and a notifier. What may not happen is the operator's side gaining WRITE access to
anything the daemon executes.

**Acting: the agent account, because nothing else can.** Restarting the server means signalling
and spawning processes owned by the agent account, and an admin-side job that could do that would
need `sudo` on a timer. Recovery therefore stays inside the daemon.

`/api/health` is reachable from the operator's account because loopback is machine-wide. That is
the same property `tailscale serve` depends on above, and the same reason the bearer token — not
the account boundary — is what protects the port.

### The `KeepAlive` question, reopened rather than answered

A `LaunchDaemon` makes an option available that plan 006 did not have, and it is worth naming
before someone assumes the old answer still holds.

If the **server itself** is the daemon job with `KeepAlive`, then failure (1) — the process exits
— is handled by launchd directly, with no script, no polling and no timer. The watchdog would
shrink to failure (2) alone: notice a wedge, kill the process, and let launchd bring it back.
That is a smaller thing to get right than a script that both diagnoses and spawns.

What blocks taking it here is plan 006's argument against `KeepAlive`, which does not go away:
**every deliberate refusal exits non-zero.** A server with no `AGENTDECK_MOUNTS`, no
`AGENTDECK_PROFILES` or no `AGENTDECK_ORIGIN` must refuse rather than come up weaker, and under
`KeepAlive` launchd relaunches each refusal every `ThrottleInterval` — the crash-loop, one layer
below where the give-up logic can see it. Three ways out exist and none is obviously right:
raising `ThrottleInterval` and accepting a slow loop; giving refusals a distinct exit code and
using `KeepAlive`'s `SuccessfulExit`/`ExitStatus` conditions, which trades one subtle plist
behaviour for another; or keeping the wrapper script exactly as plan 006 has it and getting none
of the simplification.

**This plan does not choose.** It records that de-containerising made `KeepAlive` unavailable and
the `LaunchDaemon` made it available again, and that the choice belongs to whoever builds M4 with
the refusal paths in front of them. What it does rule out is adopting `KeepAlive` without
answering the refusal case, because that converts a loud, correct refusal into a silent loop.

## Where the work lives, and how it gets to GitHub

The repositories are cloned in the **agent account's** home and `AGENTDECK_MOUNTS` comes from
`ghq list -p` run as that account — the `Makefile` already computes it that way, so nothing in the
repo changes. The operator can read them (`staff`, `0750`) but should not write them; the way in
is the deck itself, or `ssh agent@localhost`, or `su - agent` in Terminal.

**The `host-executed files` hazard shrinks to the agent account.** `package.json`,
`eslint.config.mjs`, `mise.toml`, `scripts/`, `src/**/*.test.ts` are still agent-writable and
still executed by whoever runs the toolchain — but that is now the agent account, in its own home,
with no `sudo` and no write access to `/opt/homebrew`. The `git status` / `git diff` review before
a `pnpm install` remains worth doing and stops being the only thing between an agent and the
machine. This is the same benefit the container and the VM offered, obtained without either.

**Pushing.** If agents push, the git remote stops being the last line of defence and the
credential in the agent account becomes the thing that matters:

- The operator's `~/.ssh/id_ed25519` must never be copied into the agent account. It authenticates
  everywhere GitHub accepts that key.
- Per-repository **deploy keys with write access**, generated in the agent account, or a
  fine-grained token scoped to named repositories.
- **Branch protection or a ruleset on each of those repositories**, refusing force-push and
  deletion on the default branch. With the key on the machine this is the only control that is not
  advisory.
- agentdeck itself keeps the existing rule — commit, do not push, no remote configured. It is the
  one repository whose files the operator's own toolchain executes.

## What this does not buy

- **Same-uid is untouched.** Every agent session, the server, the token at `~/.agentdeck/token`
  and every hook secret share one account. Anything an agent runs can read all of it. The standing
  residual in CLAUDE.md moves down one level; it is not solved, and no account split solves it.
- **Local privilege escalation.** A macOS LPE bug reaches root from a standard account, and those
  are more common than hypervisor escapes. This design stops accidents and stops the human-runs-an
  -agent-written-file class of problem. It does not stop an attacker who brought an exploit.
- **Reading the operator's home once `chmod 700` is done** is closed by file mode, which is a real
  boundary and also a single command away from being undone by anything running as the operator.
- **The Mac mini asleep is still everything down.** Unchanged from plan 006, and more likely to go
  unnoticed with no one logged into the account: `sudo pmset -a sleep 0`, display sleep left
  alone.

## Milestone placement and done-when

This is M4 work, alongside the watchdog it rewrites, and it supersedes plan 006's `LaunchAgent`
install section rather than adding to it.

Done when, each demonstrated on the Mac mini rather than argued:

1. `sudo -u agent sudo -v` fails, and `dscl . -read /Groups/admin GroupMembership` does not name
   the agent account.
2. `sudo chmod 700 /Users/<operator>` is applied, and as the agent account `ls /Users/<operator>`
   is denied.
3. As the agent account, writing to `/opt/homebrew/bin` is denied.
4. The `LaunchDaemon` is loaded, the operator is **not** logged into the agent account, and
   `curl 127.0.0.1:<port>/api/health` from the operator's session answers ok. A reboot reproduces
   it with nobody having logged in at all.
5. The plist carries `AGENTDECK_MOUNTS`, `AGENTDECK_PROFILES` and `AGENTDECK_ORIGIN`; plan 006's
   rule that a recovery may not hand back a weaker server is what makes all three load-bearing,
   and the boot report can no longer warn about the third.
6. `tailscale serve` is configured in the operator's account and the phone reaches the deck.
   Separately, as the agent account, `tailscale status` fails — the account cannot change what is
   exposed.
7. The plist, the installed watchdog script and `ProgramArguments[0]` are all unwritable by the
   agent account, checked as that account rather than read off an `ls`.
8. A session started from the phone runs as the agent account (`ps -o user=`), and its `cwd` is
   under the agent account's home.
9. From the operator's account, with no `sudo`: `/api/health` answers, the daemon's log is
   readable, and the notifier's `osascript` puts a real notification on screen. Killing the server
   produces that notification in the operator's session — which is the give-up case rehearsed
   deliberately rather than met for the first time when it matters.

**Not demonstrated by any of the above, and to be written as such in `TODO.md`:** that an agent
cannot reach the operator's account by some path not enumerated here. The list is what was
measured on 2026-08-09, not a proof of completeness.

## Documents this invalidates

Filed here rather than discovered later:

- **Plan 006, "The watchdog: a `launchd` agent on the Mac"** — `LaunchAgent` becomes
  `LaunchDaemon` with `UserName`; the `osascript` notification moves out of it and into the
  operator's own account; the plist's environment gains the tailnet origin the boot report can no
  longer supply; and the watchdog splits into a detect-and-tell half and an act half that cannot
  live in the same account. `RunAtLoad` and `StartInterval` survive unchanged. **"No `KeepAlive`"
  is reopened**, not overturned — see above.
- **`scripts/watchdog.mjs` and README's "Installing it"** — both describe a `~/Library/LaunchAgents`
  install and the copy-out-of-the-checkout argument for it. The copy is still right; its
  destination and owner change, and the section's honest caveat that the copy buys review scope
  rather than write protection is the part that stops being true.
- **CLAUDE.md and README's "runs as you"** — it no longer does. Every sentence that says the
  server and the agents run as the operator needs to say which account, because the whole value of
  this plan is in that distinction.
- **Plan 005's superseded header** — its list of what is no longer protected (home directory, SSH
  keys, browser profiles, other repositories, keychain, system files) is protected again by this
  plan, by a different mechanism. It should say so and point here.
