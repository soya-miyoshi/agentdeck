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
- **The tmux prefix is disabled on agentdeck's socket** (`prefix none`), because everything typed on
  the phone reaches a tmux client's key parser — `Ctrl b :` was arbitrary host command execution.
  Attaching to that socket by hand therefore has no tmux bindings.
- **The watchdog is written but not installed**, by choice. `launchctl` is Soya's to run. Its
  install changed shape before it was ever run: plan 008 makes it a root-owned `LaunchDaemon`, not
  the `LaunchAgent` plan 006 and the README still describe, and drops its `osascript` notification
  because a daemon-launched account has no GUI session to notify.
- **Same-uid is the standing residual.** Every agent runs as the operator, so the token, the hook
  secrets and the tmux socket are all readable by anything they run. It is recorded, not solved —
  and plan 008 does not solve it either. A separate account moves the residual down one level:
  agents stop sharing a uid with _you_, and go on sharing one with each other.
