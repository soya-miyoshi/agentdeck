# Audit

One section per iteration, appended by the `iterate` skill's final whole-codebase pass.

That pass runs **after** the last fix round, so its findings have had no chance to be fixed
inside the iteration. This file is therefore a ledger of what is open or deliberately accepted,
not a record of what was resolved. Findings closed during the iteration are noted with the commit
that closed them; anything else is still live.

---

## m0/toolchain - 2026-08-04

TypeScript, eslint, prettier and `node:test` on Node 22's type stripping, plus the suite that
proves the toolchain runs. No runtime dependencies added - the six-dependency budget is untouched,
and the test runner is the one Node ships rather than a seventh entry.

### Findings

- [medium] `docker-compose.yml` - **agentdeck is bind-mounted into its own container, so the files
  the host executes are agent-writable.** Failure: an agent rewrites `eslint.config.mjs`,
  a `package.json` script or the `Dockerfile`; the next host-side `pnpm lint` or
  `docker compose up --build` runs agent-authored code on the Mac with the human's identity -
  the identity plan 005's credential split exists to keep away from the agent.
  Status: documented and controlled by review discipline in `f685b44`; structurally reduced in
  `0e9d8a7`. Residual: review discipline is the control for the four tracked files, which is
  weaker than a boundary. Accepted, recorded in plan 005.

- [high] `node_modules/` **and** `.pnpm-store` **are gitignored, so the `git status` control above
  cannot see them.** Failure: an agent rewrites `node_modules/.bin/eslint` - a `/bin/sh` shim -
  and `git status` reports clean. The human takes the sanctioned host exception and executes it.
  Verified reachable: uid 1000 in the container can write both paths.
  Status: fixed in `0e9d8a7`. Both are now container-local volumes layered over the bind mount,
  so the tree the container executes is not the host's. Habit cannot cover a file review cannot
  see, so this half is structural rather than documented.

- [high] **The user's bearer token was to be written at the repository root, inside a bind mount
  every session can read.** Failure: an agent working in agentdeck meets it in an ordinary
  `ls -la` and it lands in a transcript on its way to a model API. In hostile hands it is
  `POST /api/sessions` in any mounted repo, `DELETE` on live sessions, and a WebSocket attach that
  reads and types into every other agent's terminal. Plan 002 draws exactly this line: a session
  secret can lie about one session, the user's token can start processes.
  Status: fixed in `0e9d8a7`. Moved to `AGENTDECK_TOKEN_FILE=/var/lib/agentdeck/token` on a
  container-local volume, outside every bind mount. Residual: same uid means this hides the token
  rather than isolating it. The only thing that isolates it is a distinct uid for agent sessions,
  which plan 005 now names and which is **not taken**.

- [medium] **The documented safe in-container toolchain path did not run.** Failure: `pnpm` was
  absent from the image, so `docker compose exec -T app pnpm lint` failed outright and every lint
  and test run fell back to the host exception - the one path the containment argument exists to
  avoid. The test passed because it grepped the README prose instead of running the command.
  Status: fixed in `0e9d8a7`. `corepack prepare pnpm@9.15.9` is in the image and the documented
  command carries `-w /workspace/agentdeck`. Verified by hand: `pnpm --version` returns 9.15.9 in
  the container and typecheck, lint and test all pass there.

- [high] **`pnpm-lock.yaml` is agent-writable and was installed on the host by the only documented
  install command.** Found by the final whole-codebase pass, and only visible there: it exists
  because this branch's new lockfile met `mise.toml`, which was already on `main`. Failure: an
  agent edits a `resolution: {tarball: ...}` entry or adds a devDependency with a postinstall;
  the human runs the documented `mise install && pnpm install` on the Mac; pnpm 9.15.9 - unlike
  pnpm 10 - does not gate dependency lifecycle scripts, so it executes with the human's full
  identity including `~/.ssh`. A thousand-line lockfile diff is exactly the diff nobody reads.
  The container-local `node_modules` volume protects the installed tree, not the input.
  Status: fixed on this branch. `mise.toml` now documents the in-container install;
  `pnpm-lock.yaml` is on the review list in the README, plan 005 and
  `src/containment.test.ts`'s `hostExecutedFiles`.

### Open after this iteration

Nothing blocking. One standing residual, carried forward rather than closed:

- **Same-uid.** The server and every agent session run as uid 1000, so file mode buys nothing
  between them. The token move hides it from a working-tree read; it does not isolate it. A
  distinct uid for agent sessions is recorded in plan 005 as the only real fix and has not been
  taken. Revisit when M1 writes the token for real.

---

## m0/ci - 2026-08-04

GitHub Actions running typecheck, lint and test on the runner directly, with corepack pinning
pnpm 9.15.9 to match the container. Does not build the arm64 image - nothing in CI would run it.

Every finding this iteration is the same root cause seen from a new angle: **agentdeck is
bind-mounted into the container that runs agents**, so anything in the tree that the _host_ later
executes is agent-writable. Iteration 1 found `node_modules` and `pnpm-lock.yaml`. This one found
five more surfaces.

### Findings

- [high] `.git/config` and `.git/hooks/` **are agent-writable and untracked, so the prescribed
  `git status` / `git diff` review cannot see them - and `git diff` is itself the trigger.**
  Failure: an agent writes `[core] pager = sh -c '... | sh'` into `.git/config`; the human runs
  the mandated pre-build `git diff` and git executes it on the Mac. Or it writes
  `.git/hooks/pre-commit`, and the next commit this very pipeline makes fires it with `~/.ssh` in
  reach. Needs no `--build` and no host `pnpm` at all.
  Status: fixed in `0823b6e`. Both are on the review list in README, plan 005 and
  `hostExecutedFiles`; the review checklist gained `git config --local --list` and
  `ls -la .git/hooks`, which are the only two commands that can see them; and host git in the
  skill runs `-c core.pager=cat -c core.hooksPath=/dev/null`.

- [medium] `.github/workflows/` **was created by this branch and left off the review list, and a
  workflow declares its own `permissions`.** Failure: an agent adds `permissions: contents: write`
  plus a `run:` step; the human reviews exactly what the README lists, does not look at it, and
  pushes. Status: fixed in `0823b6e`, added to all three lists.

- [medium] **Enumerating filenames is the wrong shape where the host tool auto-discovers config.**
  Prettier imports every entry of its `plugins` array from any `.prettierrc*`; mise reads
  `.mise.toml`, `mise.local.toml` and `mise-tasks/`. The list named `eslint.config.mjs` and
  `mise.toml` only. Status: fixed in `0823b6e` - the list now names surfaces (`eslint.config.*`,
  `.prettierrc*`, `.mise*.toml`, `mise-tasks/`) and states that the enumerated set is a floor,
  not the whole review.

- [medium] **No `no-new-privileges` or `cap_drop`; the container kept 8 setuid-root binaries.**
  Status: fixed in `653068f`.

- [high, audit] **The skill claimed "every host git command is hardened" while only four were.**
  Every stage prompt ends with "Commit.", and those commits are host git run by a subagent, which
  no per-command flag in the skill reaches. The containment test asserted `uses.length >= 4` - a
  floor that certifies partial coverage as complete, which is the same failure mode as the
  four-file list it was written to police.
  Status: fixed on this branch. The instruction moved into the shared prompt every stage receives,
  which is the only layer that reaches a subagent's own commits, and the test now asserts that
  rather than counting call sites.

### Open after this iteration

- **The root cause is untouched.** Two iterations have now spent most of a high-effort security
  budget rediscovering variants of one decision. Plan 005 names both real fixes - a distinct uid
  for agent sessions, or not mounting agentdeck into itself - and neither is taken. Every
  remaining item pays this tax until one of them is.
- **Same-uid**, carried forward from `m0/toolchain`. Unchanged.
- **The verify pass echoed its input** instead of re-reading the code: it reported three findings
  as open that `fix:2` had already closed, confirmed by hand. The prompt needs to require quoting
  the current line it judged, not just a verdict.

### Process failure found while merging m0/ci

A fix agent created its own branch (`security/host-execution-surface-and-caps`) and committed
every security fix there instead of on `m0/ci`. The iteration then merged `m0/ci`, which held only
the coder and QA commits, printed MERGED, and passed its suite - because the suite had been run
before the branch switch. Both security rounds' work was absent from `main` while every signal
said the iteration had succeeded. Recovered by merging the stray branch; no work was lost.

Two controls added to the skill: the shared prompt now forbids stages from creating or switching
branches, and the after-workflow steps require checking `git branch --show-current` and the recent
branch list before merging, and re-running the suite on the branch actually being merged.

## m0/de-containerise - 2026-08-07

The container is gone; agentdeck runs on the Mac. This iteration made the documents say so. Plan
005 keeps its reasoning under a superseded header, plans 001/003/004/006, the README, `mise.toml`,
the `cwd` refusal and the port-clash message stopped describing an image, `scripts/healthcheck.mjs`
gained its `/api/health` half, and the in-image toolchain test was removed rather than left to
self-skip. `Dockerfile`, `docker-compose.yml` and `docker/` are retained on disk, unreferenced,
because how this is eventually deployed is deliberately open.

Security gate: two rounds, 6 then 4 findings, 4 and 2 actionable, all fixed; the verify pass
reported 0 still open. The findings below are the final whole-codebase audit, which by
construction has no fix round after it. **This branch is NOT merged.** Five of them are `high`,
two are verified by hand, and three of the five ask for decisions the item put out of scope.

### Findings

- [high] src/tmux.ts:114 - The tmux server inherits the launching shell's whole environment, so
  plan 004's `env` name allowlist is decorative. `ensureServer()` runs `tmux start-server` as a
  child of the node process, so the server's global environment is whatever shell ran `pnpm start`;
  `-e` on `createOrAttach` adds to that rather than replacing it. Failure: every agent session gets
  `SSH_AUTH_SOCK`, and an agent with the forwarded ssh-agent can `git push --force` to every repo
  that key reaches - which is exactly the credential split plan 005 exists to enforce, and the
  README still points at that plan for it.
  **Verified by hand on this Mac**, and worse than reported: a pane spawned by that server saw
  both `SSH_AUTH_SOCK` and an arbitrary `SEKRIT` variable from the launching shell that no profile
  allowlisted. Status: FIXED in m0/host-boundary. Every tmux invocation, and so the server it
  starts, is given an environment built from `BASE_ENV_NAMES` in `src/tmux.ts`; `update-environment`
  is emptied so no attaching client can inject either. Re-verified by hand: with `SEKRIT_MARKER` in
  the launching shell, a pane started through `POST /api/sessions` has neither it nor
  `SSH_AUTH_SOCK`, and a real-tmux test in `src/tmux.test.ts` now runs that check.

- [high] src/hub.ts:55 - The cwd allowlist is now called the only boundary left, and does not bound
  the session set at all. `Hub.sync()` attaches to everything on the tmux socket by design, and the
  socket is `/tmp/tmux-<uid>/agentdeck`, reachable by every process running as the user. Failure:
  `tmux -L agentdeck new-session -d -c / -- /bin/sh` becomes a tab within one 2s sync, streamed to
  the phone and accepting input, with `CwdAllowlist.allows` never consulted. Status: FIXED in
  m0/host-boundary, the user having decided the allowlist IS a boundary. `Registry.list` filters to
  allowlisted cwds - one filter, so the session list and the hub cannot disagree - and `Hub.sync`
  attaches only to what it returns. The accepted cost (a hand-started session, and a session that
  outlives a restart, are not tabs) is written into plan 005's header, the README and
  `CwdAllowlist.refusal`.

- [high] src/tmux.ts:76 - Per-session hook secrets are one tmux command away from any same-uid
  process. `createOrAttach` passes `spawnEnv` as `-e NAME=VALUE`, and tmux stores it in the session
  environment. Failure: `tmux -L <socket> show-environment -t <session>` prints `AGENTDECK_SECRET`
  in full - no ptrace, no `/proc`. plans/002-wire-protocol.md:131 documents the leak as
  `/proc/<pid>/environ`, a Linux path macOS does not have, so the plan describes a mechanism this
  host lacks while the easier one goes unmentioned. **Verified by hand.** Status: FIXED in
  m0/host-boundary. `createOrAttach` unsets every `-e` variable from the session environment in the
  same chained invocation that forks the pane, so the agent keeps its secret and
  `show-environment -t` prints nothing; verified by hand and by a real-tmux test. Plan 002's
  paragraph now names what this host has - the tmux read, now closed, and same-uid debugger and
  file access, which are not.
  Reopened and closed again the same day: that fix left the same values in the tmux client's argv,
  which `ps` shows to every same-uid process even on a macOS that hides the environment - verified
  here with `ps -Ao args=`, so an agent polling `ps` could read the next session's secret and the
  operator's `ANTHROPIC_API_KEY` out of a `new-session` client that lives for milliseconds. No
  value is an argument now: they travel in the creating client's own environment and a momentary
  `update-environment` name list, set immediately before `new-session` and emptied immediately
  after in the same invocation, is what copies them into the session the pane is forked from.

- [high] README.md:195 - The documented replacement for the container-local `node_modules` volume
  cannot see what it claims to, and a test certifies it. `git status --ignored -- node_modules
.pnpm-store` emits one line naming the directory, never its contents, so a rewritten
  `node_modules/.bin/eslint` produces byte-identical output. src/containment.test.ts:121 asserts
  the string is present in the README, turning an ineffective control into a green check. Status:
  FIXED in m0/host-boundary. Nothing that reads the tree can do this job, so the control is
  replacing it: `rm -rf node_modules .pnpm-store && pnpm install --frozen-lockfile` from the
  lockfile reviewed in the same diff. The test is inverted - it now demonstrates the old command's
  blindness against a scratch repository and fails if the README prescribes it again.

- [high] plans/005-containment.md:130 - Host paths outside the repo became execution surfaces and
  the review checklist is still repo-scoped. `~/.gitconfig` (`--local` explicitly does not show it,
  and an `!alias` fires on the very `git diff` the checklist prescribes), `~/.claude/settings.json`
  and `~/.claude/skills/`, `~/Library/LaunchAgents/`. Plan 005 still recommends keeping the iterate
  skill in `~/.claude/skills` "so the agent it constrains cannot write it" - true only because of
  the container, and the superseded header does not retract it. Status: FIXED in m0/host-boundary.
  The header names all four host paths with the commands that can see them (`git config --global
--list`, `ls -la ~/.claude/skills ~/Library/LaunchAgents`, a diff of `~/.claude/settings.json`)
  and explicitly retracts the `~/.claude/skills` recommendation: on the Mac that directory is as
  writable to the agent as the repository, and moving the skill there moves it out of review.

- [medium] src/de-containerise.test.ts:52 - plan 002 is excluded from the swept document list with
  the comment "002 never described one". It describes one six times, in the load-bearing places:
  `Session.cwd` ("absolute path inside the container"), the allowlist definition, the refusal
  rationale, the hook route. Plan 002 is the wire contract. Status: FIXED in m0/host-boundary.
  Plan 002 is on the `decontainerised` list and no longer describes one.

- [medium] src/server.ts:94 - The token file's default is `/var/lib/agentdeck/token`, which no
  ordinary Mac user can create, so `pnpm start` fails on a clean host. **Confirmed by hand: the
  server refuses to start.** The one rule plan 005 says survives - never inside a tree a session is
  pointed at - is prose in three places and checked by no code. Status: FIXED in m0/host-boundary,
  the user having decided the home. The default is `~/.agentdeck/token`, created 0600 on first run,
  and `tokenInsideAllowlist` refuses to start when the path resolves at or inside an allowlist
  entry. Both verified by hand on a clean `~/.agentdeck`.

- [medium] src/server.ts:101 - `agentStateDir` falls back to `CLAUDE_CONFIG_DIR`, which in the
  container was a dedicated bind mount and on the Mac is the operator's live config. Failure:
  agentdeck merges its hook fragment into the settings file every Claude Code session on the
  machine reads, including sessions outside the allowlist, and rewrites it on every boot. The boot
  warning only fires when neither variable is set, so the silent-landing case is the unwarned one.
  Status: FIXED in m0/host-boundary. The fallback is `~/.agentdeck/agent-state`, a directory that is
  agentdeck's to write, and the warning now fires whenever `AGENTDECK_AGENT_STATE_DIR` itself is
  unset - which is the silent-landing case.

- [medium] plans/005-containment.md:8 - The superseded header enumerates filesystem reach but not
  `cpus`/`mem_limit`, `no-new-privileges`/`cap_drop`/non-root, or the container lifecycle as a
  persistence bound. A runaway agent now takes the laptop, which is an availability failure plan
  006's watchdog assumes cannot happen; and `~/Library/LaunchAgents` persistence is a category the
  container previously bounded. Status: ACCEPTED WITH A REASON in m0/host-boundary, which is what
  the user decided: all three are named in plan 005's header as unbounded. CPU and memory are
  carried by `m4/launchd-watchdog`, because the honest fix is a supervisor that can notice and act
  rather than a limit invented on this branch; the privilege drops have nothing left to drop, since
  the session already runs as the human; persistence via `~/Library/LaunchAgents` is unbounded and
  on the review list. **No CPU or memory limit was built, deliberately.**

- [low] .github/workflows/ci.yml:6 - Header still says CI is "the one place `pnpm install` runs
  outside the container", now false. Survived the sweep because it says `container` and the sweep
  greps `docker`. Status: FIXED in m0/host-boundary. The header now says the runner's install is
  the SAFE one and the Mac's is a review gate.

- [low] src/claude-hooks.ts:211 - src/ still describes a container in four places, and
  de-containerise.test.ts:151, named "nothing that runs describes a container", asserts only
  `/docker/i`. Status: FIXED in m0/host-boundary. The scan asserts `/\bcontainers?\b/i` over src/
  and scripts/ as well, and the four docstrings are rewritten. Test files are exempt from that half
  only - `containment.test.ts` has to name what the container used to cover in order to assert that
  nothing still credits it.

- [low] src/server.ts:126 - `AGENTDECK_ORIGIN` appears in no README section and no example env
  file, only a `console.error` on a process nothing supervises. Unset, `/api` and `/ws` accept any
  Origin, which is the state of every ordinary run. Status: FIXED in m0/host-boundary. The README
  has an Environment section listing every variable the server reads, what each default is, and
  what an unset one means - `AGENTDECK_ORIGIN`'s row says the Origin check is off.

### Found while verifying, not by the gate

The suite was RED on arrival at the merge step: 2 of 335 failing. `de-containerise.test.ts` scans
every tracked `*.test.ts` for skip/todo markers and `.dockerenv`, and scanned itself - its own
search regexes contain those literals. The QA and refactor stages both returned `ok: true`; the
commits that added the tripping prose (448623a, 7611b75) landed after the stage that ran green.
Fixed here by excluding the scanner from its own scan. The lesson is the skill's existing one: a
stage's `ok: true` is a claim about when it ran, not about the branch.

### Closed by m0/host-boundary

Every finding above is marked FIXED or ACCEPTED WITH A REASON. Three of them were the user's
decisions rather than the auditor's, taken on 2026-08-07 and recorded in plan 005's superseded
header: the token's home is `~/.agentdeck/token` with a start-time refusal; the cwd allowlist is a
boundary and bounds the session set; and the container's resource and persistence reach is named as
unbounded rather than rebuilt, with the resource half carried by `m4/launchd-watchdog`.

What is still open, unchanged and carried forward: **same-uid**. The server and every session run
as the human, so one agent can attach a debugger to another and read every file that user owns.
Placement, the environment allowlist and the tmux fix take away the easy reads; none of them is a
boundary. A distinct uid for agent sessions remains the only real fix and remains untaken.

## m0/host-boundary - review of the fixes above - 2026-08-07

Two findings against the branch that closed the section above. Both are about the same thing: a
claim that was true of the mechanism it was written for and not of the residue beside it.

- [medium] src/tmux.ts:148 - The values taken out of the tmux SESSION environment were still in the
  tmux CLIENT's argv, and macOS shows every process's argv to every process this user runs even
  though it hides the environment - verified here with `ps -Ao args=`, which printed a sibling's
  full command line. Failure: an agent sampling `ps` in a loop catches the `new-session` client
  created for the next session and reads its `AGENTDECK_SECRET` and the operator's
  `ANTHROPIC_API_KEY`, which is the one credential plan 004 keeps out of every file. Status: FIXED
  in m0/host-boundary. No value is passed as an argument. They travel in the creating client's own
  environment, and an `update-environment` name list set immediately before `new-session` and
  emptied immediately after - in the same invocation, so the next client cannot be caught by it -
  is what copies them into the session the pane is forked from. Covered by a test that scans every
  argument of every call for a value, and by the existing real-tmux test for the pane's half.

- [medium] README.md:142 - "Built, not inherited" bounds what a pane INHERITS and not what its own
  shell puts back. `HOME` must be on `BASE_ENV_NAMES`, and the shipped `agents.example.json` ran
  `/bin/zsh -l` - a login shell, which sources `/etc/zprofile`, `~/.zprofile`, `~/.zshrc` and
  `~/.zlogin`. Failure: the `export SSH_AUTH_SOCK=...` that 1Password and `ssh-agent` both document
  puts the forwarded agent back in every session, which is exactly the `git push --force`
  capability the README says is gone; Claude Code is the same shape, since it execs a snapshot of
  those rc files. Status: FIXED as far as it can be. The example profile no longer passes `-l`, and
  the README and plan 005 now say that keeping a credential out of a session means keeping it out
  of the dotfiles `HOME` points at. A real-tmux test spawns a login shell against a temporary
  `ZDOTDIR` and asserts the variable does come back, so the documented residue is checked rather
  than asserted. Not closed, because it cannot be: a profile that starts a login shell, or an agent
  that reads rc files itself, re-establishes whatever those files export. The only real fix is the
  one already open - a distinct uid, with its own home.

---

## m0/host-boundary - final whole-codebase pass - 2026-08-07

The item that took the twelve findings of `m0/de-containerise` and the two decisions it deferred.
All twelve are marked FIXED or ACCEPTED WITH A REASON in the section above. The token now defaults
to `~/.agentdeck/token` created 0600, and the server refuses to start if that path resolves inside
an allowlist entry; the `cwd` allowlist became a boundary rather than a check on
`POST /api/sessions`. Both were the user's call, taken on 2026-08-07.

The audit below runs after the last fix round and so has no fix round of its own. Two of its
findings were nevertheless fixed on this branch before the merge - the `high`, because the branch
must not ship a claim it does not keep, and one `medium`, because the branch introduced it. The
rest are recorded and open.

### Findings

- [high] src/tmux.ts:262 - "A session's environment is built, not inherited" failed open, silently,
  on any tmux server agentdeck did not start, and the comment saying it could not be fixed was
  wrong. `start-server` is a no-op against a socket that already holds a live server, so only the
  CLIENT half of the environment was ours; the pane inherits the server's global environment, which
  is whatever shell started it. The trigger is prescribed by our own text: `CwdAllowlist.refusal()`
  and the README both tell the operator to `tmux -L agentdeck attach` to reach an orphaned session,
  and attaching starts a server. `exit-empty off` then keeps it alive indefinitely. Failure:
  every session created afterwards gets the forwarded ssh-agent, which plan 005 prices as
  `git push --force` to every repository that key reaches. **Verified by hand on tmux 3.7b, and
  worse than the branch assumed: emptying `update-environment` makes it worse rather than better,
  because tmux's own default list names `SSH_AUTH_SOCK` and was overwriting it from our clean
  client by accident.** With the list emptied and a dirty pre-existing server, a pane created
  exactly as `createOrAttach` builds it saw both a marker variable and the agent socket.
  Status: FIXED in 6500400. `ensureServer` sweeps every global not on `BASE_ENV_NAMES` with
  `set-environment -g -u` and logs what it cleared; `PWD` is skipped because tmux sets it on a
  server we started ourselves. Covered by a real-tmux test that fails without the fix.

- [medium] src/registry.ts:166 - `reap()` became unreachable at boot, so a dead session left by a
  previous run stayed on the socket forever and the next create reported it as live. Second-order
  effect of gating `list()` on the allowlist and on `#meta`, which is memory only: after a restart
  `list()` cannot see a session this process created before, and `reap()` filters through `list()`.
  `remain-on-exit on` keeps the corpse. Failure: `sessionId(cwd, agent)` is pure, so the next
  `POST /api/sessions` for that repo hits it, tmux reports `attached`, and the phone gets a 201
  carrying "a claude session was already running in <cwd>; you are attached to it rather than to a
  new one" - false - plus a tab pinned at `exited` with no agent started, which the user must close
  before the agent will start. Status: FIXED in b7cdbca. `create()` kills a dead session under its
  own id first, scoped to a cwd already allowlisted and a pane tmux reports dead. Reaping against
  the unfiltered list was the other option and was not taken: it would widen what this process
  kills to sessions it never started.

- [medium] src/server.ts:71 - The bearer token moved to a user-writable, guessable path and
  `loadToken` adopts whatever it finds there. `readFileSync` returns any non-empty content as the
  token, with no ownership, mode or symlink check; the 0600 is applied only on the write path.
  Failure: an agent session - which plan 005 treats as capable of running a poisoned `curl | sh` -
  knows the exact path and can pre-create `~/.agentdeck/token` with a value it chose, or symlink it
  somewhere, and the next boot adopts it. Status: OPEN. Same-uid is the standing residual this
  whole file keeps returning to, and the honest fix is the distinct uid recorded in plan 005, not a
  mode check that the same uid can undo. Revisit with M1.

- [medium] src/server.ts:41 - The token's default sits in the PARENT of the directory agents are
  pointed at (`~/.agentdeck/token` beside `~/.agentdeck/agent-state`), and nothing checks that
  relationship. Status: OPEN. The refusal covers allowlist entries, which is the case the rule was
  written for; this is a second one it does not name.

- [medium] src/server.ts:57 - `tokenInsideAllowlist` is symlink-blind and fails open. Failure: an
  allowlist entry reachable by a symlinked path defeats the containment check that is the item's
  own done-when. Status: OPEN.

- [medium] src/server.ts:236 - The agent-state directory receives a hooks file, the same class of
  execution surface the profiles file was just guarded for, and gets no containment check at all.
  Status: OPEN.

- [low] src/tmux.ts:180 - The momentary global `update-environment` is a server-wide window, and
  its cleanup on the failure path is best-effort. Status: OPEN, and narrower than what it replaced.

- [low] src/registry.ts:128 - The session boundary is (remembered name + tmux-reported path) and
  both halves are computable by any process running as this user. Stated as such in the code.
  Status: ACCEPTED. It is a filter on where a session is, not a claim that agentdeck started it.

- [low] src/http.ts:211 - The 500 handler logs the whole error object, which for a `capture-pane`
  failure carries scrollback - the one thing this design says is never written down. Status: OPEN.

- [low] src/server.ts:105 - `probeTmux` is the one tmux invocation that bypasses `Tmux` and its
  built environment. Status: OPEN; it starts no session.

- [low] src/registry.ts:45 - `#meta` retains per-session hook secrets for sessions that left the
  socket by any route other than `close()`. Status: OPEN.

- [low] src/tmux.ts:368 - `Tmux.refresh` and `Tmux.resize` have no non-test callers and were
  carried through the target hardening. Status: OPEN; M2 is their caller.

- [low] README.md:133 - Recorded, not introduced: `AGENTDECK_ORIGIN` is unset by default, so the
  Origin check is off and `/api/health` answers unauthenticated to the tailnet behind
  `tailscale serve`. This branch is the one that finally wrote it into the README and a boot
  warning. Status: ACCEPTED for now. The boot warning goes to stderr on a process with no decided
  log destination, so on a launchd run nobody sees it - `m4/launchd-watchdog` is where that lands.

### Open after this iteration

- **Same-uid**, again and unchanged. Three of the mediums above (`src/server.ts:71`, `:41`, `:57`)
  are the same fact wearing different hats: the token is a file, and every agent runs as the user
  who owns it. Plan 005 records a distinct uid for agent sessions as the only real fix. Not taken.
- **The allowlist is a filter on where a session is**, not proof agentdeck started it. A same-uid
  process still owns the socket.

---

## m0/supervisor-crash-test - final whole-codebase pass - 2026-08-07

The crash test, not a supervisor: `src/supervisor-crash.test.ts` kills the node process and asserts
that tmux sessions created beforehand are alive with the same ids afterwards, and that nothing
restarted the server. Plan 003 carries the same sentence. The item's own "known gap" prose was
stale and was corrected rather than certified: since `m0/host-boundary` gated `Registry.list()` on
`#meta` as well as the allowlist, a session that outlives the server is not listed AT ALL, rather
than listed under its raw id.

Two of the audit's findings were regressions this branch introduced with the `curl` -> `node -e`
change and are fixed here. The rest are recorded and open.

### Findings

- [medium] src/claude-hooks.ts:134 - Widening `HOOK_MARKER` to the generic `/api/hooks/` turned
  `isOurHook` into a substring test that matches strangers. `mergeHookSettings` promises to
  preserve hooks it did not write and `installHookSettings` re-runs at every boot, so an operator's
  own guard hook posting to any local service with `/api/hooks/` in its path would be deleted
  silently, with no log line. A deleted deny/guard hook is a security downgrade performed by the
  component whose contract is not to touch other people's entries. Status: FIXED on this branch.
  `isOurHook` now requires both `/api/hooks/` and `AGENTDECK_SESSION_ID`, which every form we have
  emitted contains, so the upgrade path is kept. Covered by a test that fails without it.

- [medium] src/claude-hooks.ts:167 - `curl -m 2` was a cap on the whole operation; the node form
  lost it. `http.request` is only constructed inside the stdin `end` handler, so `timeout: 2000` -
  itself only a socket-inactivity timer - cannot start until stdin closes, and nothing bounds the
  stdin read or the `b += c` buffer. A hook whose stdin is inherited and never closed leaves a Node
  runtime resident for the life of the session, accumulating the payload in heap. Status: FIXED on
  this branch: an unref'd 2s `setTimeout(...process.exit(0))` as the first statement, and the
  buffer stops appending past 64KB, which is the body size the server refuses anyway.

- [medium] src/server.ts:131 - `AGENTDECK_AGENT_STATE_DIR` gets none of the allowlist-containment
  guard applied to the token and profiles files, though `installHookSettings` writes a file there
  whose `command` strings the agent runs through a shell on every tool call, and `mergeHookSettings`
  deliberately preserves entries it does not recognise. Point it at a repository on
  `AGENTDECK_MOUNTS` and an agent's ordinary write of one hooks entry becomes host execution on its
  next tool call and every later session, surviving reboots, with no review gate covering the file.
  Status: OPEN. Three lines to fix and it makes the rule the code already states apply to the third
  file of three; not taken here because it is `m0/host-boundary`'s rule and belongs with its
  siblings, and this branch is a measurement.

- [medium] src/server.ts:142 - The documented way to make the hook fire swaps the operator's whole
  Claude config. `CLAUDE_CONFIG_DIR` replaces the directory, not just the hooks fragment, so
  `permissions.deny`, allowed-tools and the operator's own hooks stop applying to every agentdeck
  session - on a machine the README already describes as having no boundary between an agent and
  the home directory. The obvious workaround, pointing `AGENTDECK_AGENT_STATE_DIR` at `~/.claude`,
  is what hands the merge above the live settings file. Neither consequence is stated anywhere.
  Status: OPEN, and it is a documentation debt with a security shape.

- [medium] src/claude-hooks.ts:171 - The hook client authenticates to nobody: it posts to
  127.0.0.1 on a fixed port with no check on what is listening. This branch is the one that
  establishes the window - nothing restarts the server, so the port is free for as long as the
  crash lasts - and any same-uid process that takes it harvests prompts, tool inputs and the
  per-session secret. Status: OPEN. The honest fix is the same-uid one this file keeps returning
  to; a shared secret in the other direction would narrow it.

### Open after this iteration

- **`POST /api/sessions` answers 500 on a real server run** and leaves the session it created
  orphaned on the socket. Found by hand during verification of this branch, reproduced on `main`,
  so it arrived with `m0/host-boundary`. Filed as `m0/create-500` with the reproduction and what is
  known: `Registry.list()` receives the entire unsplit `list-sessions` line as the entry id, so
  `#meta` misses. Not root-caused. **This blocks M1 in practice** - the endpoint M1 is built on
  does not work outside the fake-tmux tests.
- **Same-uid**, unchanged.

---

## m0/create-500 - final whole-codebase pass - 2026-08-08

**Root cause, and it was not any of the four the item guessed at.** A tmux CLIENT whose locale does
not say UTF-8 is not a UTF-8 client to tmux, and tmux sanitises the output of commands it prints to
one: every byte it considers non-printable is replaced with `_`. `list()` separates its fields with
U+001F, so under `env -i` - no LANG, no LC*\* , which is exactly what launchd gives it -
`list-sessions -F` came back as `name_0\_\_1786113059*/path`, `line.split(SEP)`yielded ONE field,
and every session parsed with the whole line as its id. Measured on tmux 3.7b with`od -c`: no
locale gives `f o o \_ 0`, `LC_CTYPE=UTF-8`gives`f o o 037 0`. That is why the same call worked
from a shell, which had LANG, and failed from the server. `baseEnv`now defaults`LC_CTYPE`when
the effective locale - POSIX precedence, LC_ALL then LC_CTYPE then LANG - is not UTF-8, and drops a
non-UTF-8`LC_ALL`rather than be overridden by it.`capture-pane -p` was checked the same way and
is not affected.

Verified by hand after the fix, with the exact reproduction from the item: `POST /api/sessions`
returns **201**, `GET /api/sessions` lists it, and the log is clean.

Both of the audit's `high`s are fixed on this branch, and one `medium`, because it was a regression
this branch introduced.

### Findings

- [high] src/server.ts:254 - Whichever tmux client starts a server donates its whole environment to
  that server's GLOBAL environment, and the create chain runs with `AGENTDECK_SECRET` and every
  profile API key in its environment by design. The per-session unsets at the end of that chain
  clear the SESSION environment and do nothing about the global one. `ensureServer` ran once at
  boot, which sufficed only while the tmux server could not outlive the node process - and a server
  that dies with its last session and is restarted by a create gets no `exit-empty off` and no
  sweep. **Verified by hand on tmux 3.7b: emit that exact chain against a socket with no server and
  `show-environment -g` prints the secret and the API key while the session environment is clean; a
  pane forked afterwards sees both.** Status: FIXED in 7e5eded. `createOrAttach` calls
  `ensureServer` first, which passes no `extra`, so the server is always started by a client holding
  nothing but `baseEnv()`. Covered by a real-tmux test that fails without the fix.

- [high] src/ws.ts:100 - The third fire-and-forget site, left behind when the two `hub.sync()` calls
  were hardened. `handleMessage` reaches `capture-pane` through the snapshot an attach builds, and
  `Tmux` rethrows anything that is not a missing session or an empty server, so one failing capture
  was an unhandled rejection - which exits Node, on a process nothing restarts. `execFile`'s 1MB
  default made it reachable on purpose: 2000 lines of `capture-pane -e` is agent-sized output, so a
  session that wants to can kill the server for every attached phone. Status: FIXED in 7e5eded.
  Caught and reported to the client; `maxBuffer` sized for the capture. The test asserts the socket
  survives and the client is told. Honest note on evidence: removing the fix hangs the test runner
  rather than producing a clean red, which is consistent with the rejection killing the process but
  is not a failing assertion.

- [medium] src/registry.ts:148 - `#undoCreate` killed on a warrant computed before the create.
  `attached === false` comes from a `has()` that ran BEFORE `new-session -A`, and the session name
  is computable offline by anything running as this user, so a session put under that name inside
  the window was killed by a request that did not create it. The half needing no attacker: a
  transient failure of the post-create `list()` killed the agent just started, where before this
  branch it survived and a retry adopted it. Status: FIXED in d766db3. The kill is conditional on
  tmux still reporting the session at the cwd this call passed, started no earlier than this call,
  confirmed with `display-message` rather than the `list()` that just failed. Cannot confirm means
  do not act.

- [medium] src/tmux.ts:424 - A newline in `#{session_path}` truncates the parsed path. Status:
  OPEN. It fails closed - a truncated path does not match an allowlist entry, so the session is
  dropped rather than admitted - but the failure mode is a session that silently never appears.

- [low] src/server.ts:105 - `/api/health` reports 200 for exactly the failure this branch added a
  throw for, because `probeTmux` does not use `baseEnv` and so has its own locale. Status: OPEN,
  and it means the health check cannot see the class of bug this item was about.

- [low] src/registry.ts:149 - `#undoCreate` forgets the session even when the kill fails, leaving a
  running agent the API can neither list nor stop. Status: OPEN, and now more likely by design,
  since the narrowed undo deliberately declines to kill what it cannot confirm.

- [low] src/tmux.ts:51 - `BASE_ENV_NAMES` is two lists in one: adding `LC_CTYPE` for the
  environment we build also exempted it from the inherited-globals sweep. Status: OPEN.

- [low] src/tmux.ts:169 - A profile's `env` name list overrides the locale hardening for the create
  invocation. Status: OPEN.

- [low] src/hub.ts:189 - Swallowed sync errors make the frozen-PTY case silent and permanent.
  Status: OPEN, and it is the cost of not exiting the process on a tmux failure.

### Open after this iteration

- **`/api/health` cannot see this class of failure** (`probeTmux` bypasses `baseEnv`). The one
  probe `m4/launchd-watchdog` will restart on is blind to the bug that broke every create.
- **Same-uid**, unchanged.

---

## m2/snapshot - final whole-codebase pass - 2026-08-08

`data` is now a `refresh-client -R` repaint rather than the ring buffer's contents, so a first
attach to a long-idle session paints the live screen instead of whatever output happened to be in
the buffer. Demonstrated by hand against a real session idle since before the attach, and with
`#{alternate_on}` at 1 the `history` key is absent from the frame.

Three of the audit's findings were introduced by this branch and are fixed here. The audit's own
question - what this change makes reachable in combination with code it did not touch - is what
found them, and two are only dangerous because of properties this branch added.

### Findings

- [medium] src/ws.ts:152 - The attach handler raced its own snapshot. The forwarding listener was
  registered before the snapshot was built, and the repaint's bytes come back through that same
  stream, so chunks reached a client that had no position yet. That client answers a chunk with
  `resync`, and for any session past the buffer's capacity `covers()` is false, so the server ran a
  SECOND full snapshot - another capture-pane, another refresh-client, another collection window -
  on every cold attach, the most common path in the product. With a persistently failing repaint it
  is worse: the position never becomes defined, so every chunk the agent emits produces another
  resync and another failing snapshot. **Verified by hand against the real server: three chunk
  frames arrived ahead of the snapshot; after the fix, none do.** Status: FIXED in b24a8e4. The
  listener queues until the snapshot is away, then flushes only what the snapshot does not already
  reflect.

- [medium] src/tmux.ts:557 - `repaint` resolves the session to EVERY attached client tty and awaits
  one `refresh-client` per tty, sequentially, while `Hub.repaint` started its 1000ms cap before
  those spawns. The agent in a pane owns a shell on the same uid as `/tmp/tmux-<uid>/agentdeck`, so
  it can attach as many clients as it likes; every snapshot then blew the cap before a byte was
  collected and threw, and the tab showed NOTHING - permanently, for that session, for every phone,
  while the session list and the state field still looked correct. Status: PARTLY FIXED in b24a8e4.
  The cap now starts after the tmux calls, so it measures collection rather than spawn, and an
  empty collection degrades to the buffer's contents - a stale screen rather than no screen - with
  a log line. **The root of it is still OPEN:** repaint should refresh only the client this server
  owns, whose tty is knowable, rather than every client tmux lists. Refreshing foreign clients buys
  nothing and is what makes the amplification possible.

- [medium] src/hub.ts:158 - The cold-snapshot path became a 4x fork amplifier with no bound on
  concurrent repaints: every ws frame is handled fire-and-forget with no rate limit, no per-client
  in-flight cap and no per-session serialisation, and `resync` reaches the snapshot path without
  the client being attached. One repeating client held thousands of listeners and hundreds of MB
  and forked tmux as fast as the event loop allowed, on a process nothing restarts. Status: PARTLY
  FIXED in b24a8e4 - repaints for one session share one in-flight promise, which removes the
  multiplication per session. **OPEN:** there is still no per-socket rate limit, and `input` and
  `resize` have the same fire-and-forget shape.

- [low] src/hub.ts:134 - `isAlternateScreen` reaches tmux without the `#ptys` gate its sibling
  `repaint` has, so it answers about a session this server holds no pty for. It leaks only a
  boolean. Status: OPEN.

### Open after this iteration

- **The repaint targets every client, not ours.** Named above; it is the cause the partial fixes
  work around rather than remove.
- **No rate limit on the ws message path.** `m2/reconnect` is the item that will make clients
  retry automatically, so the bound wants to exist before that lands rather than after.
- **Same-uid**, unchanged.

---

## m2/resync-ping - final whole-codebase pass - 2026-08-08

The ping is now tested against a genuinely half-open connection: `src/half-open.test.ts` puts a TCP
proxy between the ws client and the server and stops forwarding in both directions without closing
either side, which is the failure the ping exists for and the one a close, a destroy or an error
cannot model. The test says in its own comment what the proxy does NOT model - a real radio drop
also stops the server's writes from being acknowledged, and here the proxy accepts them - so the
limit of the evidence is on the record beside it. The comparative half of the done-when is in the
assertion rather than in prose: the ping notices before a status that stopped changing could.

The audit's `high` was introduced by this branch and is fixed here. Two mediums are open, and one
of them breaks an ordinary user action.

### Findings

- [high] src/ws.ts:279 - A coalesced snapshot build cached rejections as well as successes, so one
  client's failure became every joining client's failure - and the attach path treats a failed
  snapshot as a reason to detach. The victim is left detached server-side with its socket still
  OPEN and `status` still reading "open", and the shipped client sends `attach` only on pane mount
  and on reconnect, so an `error` frame just appends a banner: that tab shows a stale screen for
  the life of the process while the strip keeps reporting state from the registry. `applySize`
  after the forced detach also reflows the remaining clients' panes mid-session. Verified by the
  gate with a two-socket harness: one repaint call, two failures, `stream.clients` left empty.
  Status: FIXED in 57ad3b8. Sharing the success is the point of coalescing; a joiner that inherits
  a rejection now makes its own attempt, and the attach catch undoes only what that invocation
  registered.

- [medium] src/ws.ts:101 - **`maxPayload` at 64 KB kills the socket on an ordinary paste.** It
  applies to `input` frames, and xterm's `onData` delivers a paste as ONE event, so a pasted diff
  or stack trace is one frame. Verified by the gate: a 70 KB paste yields close 1009 with
  `sendInput` never called. The application-level error frame cannot fire, because `ws` rejects at
  the receiver before `message` - so the client sees a bare close, cannot tell it from a phone in a
  lift, runs the backoff ladder, reconnects and re-attaches every tab, each re-attach a cold
  snapshot with a real capture-pane. The paste is gone with no explanation, so the user pastes
  again. The effective limit is well below 64 KB of plaintext because `data` is JSON-stringified
  and control bytes inflate 2-6x, putting a 15-30 KB log paste over the line. Status: **OPEN, and
  it is a shipped defect rather than a hardening gap.** Not fixed here because the two ways out are
  a design choice rather than a correction: raise the socket's `maxPayload` and bound `input` at
  the application layer so an over-size frame gets an `error` naming the limit and keeps the
  socket, or chunk large pastes client-side below the cap. The second wants the client work in
  `m2/client-minimal`.

- [medium] src/ws.ts:370 - The 15s snapshot bound abandons a build it cannot cancel. `Tmux.#exec`
  passes no execFile `timeout` and a 16 MB `maxBuffer`, so with tmux wedged each eviction lets the
  next attach start a fresh child that never exits - one accumulating spawn per 15s per session, on
  a process nothing restarts. `Hub.#repaintOnce` also leaks its `onChunk` listener permanently in
  that state, because `off()` sits in a `finally` after an await that never returns, and
  `Hub.#repaints` pins the dead promise so every later build joins it. Status: OPEN. The fix named
  by the gate is the right one and is small - pass `timeout` to execFile in `Tmux.#exec`, which
  `probeTmux` already does - but it changes the failure mode of every tmux call on the branch that
  just hardened them, so it wants its own item rather than a late edit here.

### Open after this iteration

- **A paste can close the transport.** Named above. It is the first thing a person will hit that
  this file describes as known.
- **No execFile timeout on the tmux path**, so a wedged tmux accumulates children.
- **The repaint still targets every client**, carried from `m2/snapshot`.
- **Same-uid**, unchanged.

---

## m2/client-minimal - final whole-codebase pass - 2026-08-08

The client existed; the gap was evidence and a shipped defect. `src/client/end-to-end.test.ts`
drives the real client modules - `browserSocket`, `Connection`, `stream-position` - against a
spawned `src/server.ts`, the real tmux binary, a real pty and a real `/bin/sh` over a real
WebSocket, and names the two pieces it cannot cover without a DOM. The README carries the manual
recipe beside it.

The paste defect carried over from `m2/resync-ping` is fixed by chunking client-side: the client
never sends a frame the receiver would refuse, so an ordinary paste no longer closes the transport.

Six of the audit's findings were introduced by this branch. Five are fixed here; the sixth is a
property of a path this branch made reachable rather than of code it wrote.

### Findings

- [medium] src/client/connection.ts:236 - `input()` stopped going through `#send` and lost the rule
  `#send` documents: input typed while disconnected is DROPPED. The queue survived from the socket
  close to the next open - a token check with no timeout plus a backoff delay, unbounded on a
  backgrounded tab where timers are throttled - and was then written to the pty at once. A "y"
  answering a question no longer on screen; two fragments of a command line concatenated into one
  nobody typed. README.md tells the user to exercise exactly this path. Status: FIXED. Holding
  across the CONNECTING window is what `#canSend` was written for and still happens; holding across
  a reconnect does not, and the user is told what was dropped. Test fails without the fix.

- [medium] src/client/connection.ts:313 - `#releasedGroups` only emptied when the queue fully
  drained, and the producer is not the keyboard: xterm emits `onData` for the replies it owes to
  escape sequences the AGENT wrote, which is the case `MAX_PENDING_INPUT_BYTES` exists for. A loop
  on `printf '\e[6n'` added ~300k ids a second that were never removed, so the byte bound held at
  8 MiB while the Set ate the tab - the outcome the bound was added to prevent, reached by the same
  input. Status: FIXED. It is a set of session ids now, which is all the warning ever read, and the
  per-call group bookkeeping is gone rather than left written-but-unread.

- [medium] src/client/connection.ts:280 - `#overflowed` was cleared only on close, so it was once
  per SOCKET rather than the once per overflow its message claims. A queue that overflowed, drained
  and overflowed again dropped input in silence, and what is dropped is the tail of what is in
  flight while everything queued after it is still sent - so the pty receives a hole and then
  resumes. Status: FIXED, cleared when the queue drains. Test fails without the fix.

- [medium] README.md:179 - The documented dev flow stored the bearer token in `localStorage` under
  Vite's default `http://localhost:5173`, an origin shared with every other Vite project on the
  machine - and that token starts sessions in every allowed repository, kills live ones and
  attaches to every other agent's terminal. Status: FIXED. The dev server is pinned to 7778 with
  `strictPort`, and the README says why.

- [medium] README.md:173 - The documented dev flow cannot work with `AGENTDECK_ORIGIN` set. The
  proxy leaves the browser's `Origin` intact, so a server configured with the tailnet origin
  answers 403 to the upgrade and to every `/api` call; `verifyToken` treats anything that is not a
  401 as a good token, so the client reads it as a network failure and reconnects forever. Status:
  FIXED in the README. **The client half is OPEN:** `api.ts` should raise 403 as its own condition
  rather than folding it into "token still good".

- [medium] src/pty.ts:74 - An ordinary supported paste now sustains ~2.4 MB/s into a write path
  with no backpressure at any layer. Status: OPEN. This is not code this branch wrote - it is the
  path chunking made reachable at that rate, because before it the socket simply closed. It wants
  measuring before it is designed for.

- [low] src/client/connection.ts:332, :71, :83 and src/client/end-to-end.test.ts:121 - a
  pathological session id makes the frame `room` negative; the window budget counts only input
  frames, so attach/resize/resync can still exceed the server's; `MAX_PENDING_INPUT_BYTES`
  undercounts retention because queued pieces are substrings that keep the whole paste alive; the
  e2e cleanup is SIGKILL plus a best-effort kill-server. All Status: OPEN.

### Open after this iteration

- **No backpressure on the pty write path**, now reachable at paste speed.
- **`api.ts` cannot see a 403**, so an origin misconfiguration is indistinguishable from a bad
  network. `m2/reconnect` owns the ladder and is the natural home for it.
- **Same-uid**, unchanged.

---

## m2/serve-client - final whole-codebase pass - 2026-08-08

The server serves the built client from `dist/client` on every path that is not an API or socket
route, unauthenticated by necessity. Containment is verified by resolving and then checking against
the real root rather than by rejecting suspicious-looking strings. **Verified by hand against a
live server:** encoded traversal (`..%2f`, `%2e%2e%2f`) is 403; unencoded traversal falls through
to the SPA history fallback and serves index.html rather than any file; a symlink planted inside
`dist/client` pointing at a canary outside is 403, and so is one pointing at the bearer token; and
`/api/*` keeps answering JSON rather than becoming the HTML page.

### Findings

- [medium] src/server.ts:184 - Serving `dist/client` created a second dangerous location, and one
  the allowlist rule cannot describe: everything under it goes out with no bearer token, so a
  credential placed there is downloadable at a URL equal to its filename by any device with HTTP
  reach and no shell. `tokenInsideAllowlist` cannot catch it - if this repo is not itself on
  `AGENTDECK_MOUNTS` the check says nothing and the boot proceeds. The repo is also in its own blast
  radius, so an agent session started here can write a file into the published directory and have it
  served; confirmed by hand, a planted file returns 200 with its contents. Status: FIXED in cdf260c
  for the credential half - the server refuses to start if the token file or the profiles file
  resolves inside the published directory, with the same shape as the allowlist refusal. **The
  agent-writes-into-dist half is OPEN and is a property of publishing a directory at all:** an agent
  with write access to the checkout can publish arbitrary bytes to anyone who can reach the port.

- [low] src/static.ts:195 - The unbuilt-client 503 named the absolute build path on the wire, so an
  unauthenticated caller learned the account name, the checkout layout and the forge owner, in the
  state the server is most likely to be probed in. Status: FIXED. The wire answer still says
  `pnpm build`; where it writes goes to the log.

- [low] src/static.ts:56 - The API routing table now lives in two files and they disagree on case
  and encoding: `/API/health` and `/%61pi/health` return the SPA rather than the API, on a
  case-insensitive filesystem. Nothing today is served that should not be, but any future route
  outside `/api` is silently shadowed by the history fallback - an authenticated 401 becoming an
  unauthenticated 200 text/html. The `/ws` entry is also a claim nothing enforces: `ws.ts` never
  reads `req.url` and will complete an upgrade on any path. Status: OPEN.

- [low] src/client/vite.config.ts:17 - The CSP and `X-Frame-Options` this branch adds are set only
  by the production handler, so the documented dev flow - which runs against real sessions - has
  neither. Status: OPEN.

### Open after this iteration

- **A directory is published, so whatever is in it is published.** The credential case is refused
  at boot now; the general case is inherent and stated rather than solved.
- **Two routing tables**, which is a bypass shape waiting for a route outside `/api`.
- **`ws.ts` upgrades on any path.**
- **Same-uid**, unchanged.

---

## m2/client-visible-heartbeat - final whole-codebase pass - 2026-08-08

Plan 002 asked for something unimplementable: a client that reconnects after two ping intervals of
silence, where the ping is a WebSocket ping frame that JavaScript cannot observe. The plan now
carries `{ t: "ping", intervalMs }` in its frame table, sent on the same timer as the WebSocket
ping to every open socket whether or not that socket's agent is doing anything - which is what
separates "the server is alive and the agent is quiet" from "nothing is arriving". The naive
alternative, a blind silence timer, would make every idle tab reconnect in a loop.

### Findings

- [medium] src/client/backoff.ts:18 - Silence deadlines are re-armed by a heartbeat off ONE server
  timer, so every client's deadline sits within a tick of every other, and the ladder had no
  jitter. A server stall past two intervals - a `capture-pane` over deep scrollback, a burst of
  `resync`, several concurrent snapshot builds - expires all of them at once and every client walks
  the ladder in lockstep, re-attaching every open tab together. On a busy session a 30-second stall
  has rolled the 256 KiB ring buffer, so each of those attaches takes the snapshot path: a
  capture-pane, an alternate-screen probe and a refresh-client per session, aimed at the loop that
  was already stalled. Per-session coalescing stops it compounding per client, so the outcome is
  oscillating recovery rather than a wedge - and nothing restarts this process, so nothing breaks
  the oscillation. Before this branch nothing on the client could produce a correlated,
  self-initiated reconnect at all. Status: FIXED in e132cf7. The delay keeps half its step and
  spreads the rest; `random` is injected so the ladder's shape is still asserted exactly.

- [low] src/client/connection.ts:118 - `MAX_HEARTBEAT_INTERVAL_MS` was 20x the production interval
  and the stated value was never reset, so it outlived the socket that stated it. One frame saying
  five minutes moved the silence bound to ten - including the window BEFORE a socket's first frame,
  which is the stuck-CONNECTING case the watchdog exists for. Status: FIXED in e132cf7: reset per
  socket, ceiling lowered to sixty seconds.

- [low] src/client/connection.ts:574 - The watchdog makes a stuck-CONNECTING socket reach
  `#onClosed`, which calls `verifyToken()` - `GET /api/sessions`, which reaches `registry.list()`
  and spawns `tmux list-sessions` - every cycle. `verifyToken` returns true for anything that is
  not a 401, so the loop never terminates and never surfaces a diagnosis. It re-presents the bearer
  token to whatever is answering, once per cycle, forever. Status: FIXED in `m2/reconnect`.
  `verifyToken` sees a 403, and it now also tells "the server answered" from "nothing answered" -
  which is what makes the stuck case sayable at all. A probe that says the server is answering and
  this token is good, while three sockets in a row have carried nothing, is neither the network nor
  the token, and the client says so once. It does NOT stop the ladder: unlike a 401 or a 403 this
  is two facts agreeing rather than an answer from the server.

### Open after this iteration

- **`verifyToken` treats everything that is not a 401 as success**, so an origin refusal and a
  captive portal both read as "token still good" and retry forever. Two audits have now landed on
  it. `m2/reconnect` owns it and is blocked on `m2/session-metadata-survives-restart`.
  Status: FIXED in `m2/reconnect`. The verdict is now one of four - `ok`, `rejected`, `forbidden`,
  `unreachable` - and plan 002 was edited before the code was.
- **Same-uid**, unchanged.

---

## m2/session-metadata-survives-restart - final whole-codebase pass - 2026-08-08

A session that outlives the server is adopted again rather than left invisible: `#{session_path}`
is the cwd, and the id is `sessionId(cwd, agent)`, so the agent is whichever configured profile
reproduces the id from that path. Nothing is written down - no database, no sidecar - and the hook
secret is deliberately NOT recovered, because it cannot be: the running agent still holds the old
one, and a re-minted secret would never reach it. `waitingDetectionLost: true` says so on the wire.

**Verified by hand against a real server and real tmux:** created a session, `kill -9`, restarted -
`GET /api/sessions` lists it with the right cwd and agent and the lost-detection flag; a session
planted OUTSIDE the allowlist while the server was down is NOT adopted, so `m0/host-boundary`'s
boundary holds.

### Findings

- [medium] src/registry.ts:291 - **Adoption promotes a forged session name to a fully streamed,
  typed-into tab.** Before this branch `list()` required a `#meta` entry and only `create()` wrote
  one, so a session planted on the socket was dropped. Now the metadata is earned from (path, id)
  alone, and the id is a pure function of two values any client reads from `GET /api/cwds` and
  `GET /api/agents`. **Verified by hand:** with the real session killed, a session planted under
  the derived name at an allowlisted path became a tab, and the pane the phone would have streamed
  read `I_AM_NOT_YOUR_AGENT`. The operator's keystrokes would go to it. Marginal over what a
  same-uid attacker already has - `send-keys` into the real session, `capture-pane` off it - but a
  DIFFERENT primitive: impersonation of a trusted tab rather than interference with a real one.
  Status: **ACCEPTED WITH A REASON, and it is the most consequential judgement on this branch.**
  Provenance needs something written down and plan 001 forecloses it; the code already stated the
  weaker claim - "a filter on where a session is, not a claim that agentdeck started it". The
  alternative is leaving the tab blank after every restart, which is the gap this item exists to
  close. Mitigated by visibility rather than prevention: every adoption is logged, so an adoption
  outside the seconds after a restart is visible somewhere other than in a tab.

- [medium] src/registry.ts:328 - `reap()` cannot reach an adopted corpse, so an exited pane and its
  full scrollback stay in the tmux server's memory indefinitely, readable by any same-uid process
  via `capture-pane`. Status: OPEN, and it is a real tradeoff rather than an oversight - 501917e
  made it deliberate, because the corpse is what holds the exit report the tab shows. Bounding it
  by age is the obvious answer and the bound is a number nobody has chosen. Worth an item.

- [medium] src/registry.ts:249 - `waitingDetectionLost` is set on the wire and no client reads it.
  `m3/tab-strip` owns showing it and has not landed. Until then an adopted session comes back
  looking like a healthy tab that will never report `waiting` again - so after any restart,
  including the one `CwdAllowlist.refusal()` instructs the operator to perform to add a repo, an
  agent blocking on a permission prompt sits there with nothing on screen saying its prompt
  detection is dead. Status: OPEN, and it is a dependency `m3/tab-strip` must honour rather than a
  defect here: the API says it, the strip does not yet.

### Open after this iteration

- **An adopted tab cannot be proved to be ours.** Accepted above; the log is the mitigation.
- **`waitingDetectionLost` has no reader** until `m3/tab-strip`.
- **Exited panes are retained indefinitely** once adopted.
- **Same-uid**, unchanged, and this branch is the clearest illustration of it so far.

---

## m2/reconnect - final whole-codebase pass - 2026-08-08

The reconnect ladder, reviewed rather than rebuilt. Both halves of the done-when were already
asserted against real infrastructure in `src/client/end-to-end.test.ts` - a socket killed
mid-output repaints with no hole, and a real server SIGKILLed and restarted under a live client
repaints in a new epoch - and both still pass unchanged. This pass looked for the one failure the
whole item exists to prevent and that a green suite cannot show: a combination of the ladder's
flags (`#stopped`, `#probing`, `#carried`, `#opened`, per-socket `handled`, `#diagnosed`) that
leaves the connection with no socket, no scheduled retry and no status the user can act on. Three
were reachable, all three are fixed here, and each has a test that fails without its fix.

The server half of the storm question was checked and is sound: `buildCoalescedSnapshot` coalesces
per session, a joiner that inherits a rejection looks again before starting its own build, and the
build is raced against a bound that evicts - so a reconnect storm after a restart is one build per
session, not one per tab.

### Findings

- [high] src/client/connection.ts:717 - **A token probe that never settles wedged the connection
  permanently.** `#onClosed` clears `#socket`, sets `#probing` and awaits `verifyToken()`, which is
  `fetch` with no timeout - and the case the probe exists for is precisely the one where the
  network has gone. In that window there is no socket, nothing scheduled, and `poke()` returns
  immediately because `#probing` is the guard that stops a wake opening a second socket beside a
  ladder that is still deciding. So a request that never settles - routine on iOS for a request
  issued as the tab is backgrounded - took the connection out for the life of the tab, and the two
  events App.vue wires to `poke()`, `visibilitychange` and `online`, both hit the guard. A phone
  unlocking fires both, which is the exact moment this item is about. Status: FIXED. The probe is
  raced against `TOKEN_PROBE_TIMEOUT_MS` (10 s, generous next to the ladder's 4 s cap because a
  slow answer is still an answer); expiry is `unreachable`, not `ok`, so nothing is asserted to the
  user and the token is kept. A rejection from the injected `verifyToken` is the same answer for
  the same reason - the ladder cannot survive not getting a decision.

- [medium] src/client/connection.ts:626 - **A socket that cannot be CONSTRUCTED threw out of the
  ladder.** `new WebSocket` throws rather than closing for a blocked mixed-content or CSP-refused
  endpoint. `#open` is called from `start()` and from a scheduled retry callback, so the throw left
  no socket, no retry, and a `connecting` status that would never move again - and from a timer
  there is nobody to catch it. Status: FIXED: a socket that cannot be constructed is treated as one
  that closed, and the ladder carries on. The thrown error is swallowed rather than shown, because
  a constructor's message quotes the arguments it refused and the second argument is the
  subprotocol list, which is where the token is.

- [medium] src/client/connection.ts:594 - **`#dropSocket?.()` at the top of `#open` could leave a
  retry scheduled beside the socket it had just opened.** Dropping a socket that had CARRIED frames
  runs `#onClosed` synchronously - no probe is needed for a socket the server was talking to
  seconds ago - and that path ends by scheduling a retry. The retry then fires beside the healthy
  socket opened immediately afterwards and drops it, and every attached tab re-attaches for
  nothing: on this client a re-attach after a roll of the ring buffer is a cold snapshot per
  session, at the server that was already the reason for reconnecting. Status: FIXED: `#open`
  cancels any outstanding retry after the drop, since an open supersedes one. It cannot recurse -
  the drop's `#onClosed` either awaits the probe or returns after scheduling, never re-entering
  `#open`.

- [low] src/client/connection.ts:320 - `stop()` left the probe's bound timer running. Harmless in
  effect, since `#onClosed` re-checks `#stopped` after the probe, but a timer outliving the object
  that armed it is how a "closed" connection stops being closed. Status: FIXED: `stop()` cancels
  it, and `src/client/connection.test.ts` asserts teardown leaves no timers at all.

### Open after this iteration

- **A late `rejected` verdict from a probe the ladder has already abandoned is discarded**, so a
  token revoked during a 10-second stall is noticed one cycle later rather than immediately. The
  socket carries nothing in the meantime, so nothing is served on a revoked token; this is latency
  in signing the user out, not access. Deliberate: acting on a verdict the ladder has moved past is
  what wiped a freshly pasted token in the defect 99f1855 fixed.
- **The status stays `open` through the first, silent retry** (`showReconnecting` is false until
  one retry has failed), so for up to 250 ms a disconnected tab reads as connected. Deliberate, and
  the alternative is a banner that flashes for every ordinary drop.
- **Same-uid**, unchanged.
