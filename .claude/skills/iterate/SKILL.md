---
name: iterate
description: Run one full development iteration against a single TODO.md item - coder, QA, refactor, then an adversarial security gate that loops until clean - on its own branch, ending in a local merge to main and an audit.md entry. Use when the user says /iterate, "next todo", "do the next backlog item", or names a specific branch from TODO.md.
---

# One iteration, one TODO item, one branch

An iteration consumes exactly **one** unchecked item from [`TODO.md`](../../../TODO.md) and ends
with that item merged to `main` and ticked, or with the branch left unmerged and a reason. Never
two items. If the item turns out to be two items, say so and stop - splitting the backlog is a
decision for a person, and a branch that does two things cannot be reverted as one.

## Preflight

Every host `git` command in this skill runs as `git -c core.pager=cat -c core.hooksPath=/dev/null
…`. `.git/config` and `.git/hooks/` are inside the bind mount and are not tracked, so an agent can
write a pager, an `!alias`, a `textconv` or a `pre-push` hook that `git status` and `git diff`
cannot see and that the review itself would execute (plan 005). These two flags make git's own
execution surfaces inert for the duration. Check them directly as part of preflight:
`git config --local --list` and `ls -la .git/hooks` (a live hook is anything without `.sample`).

Refuse to start, with the specific reason, if any of these fail:

1. `git -c core.pager=cat -c core.hooksPath=/dev/null status --porcelain` is empty. Uncommitted work belongs to whoever left it there.
2. Current branch is `main` and it is the merge target.
3. An item is selected: the argument if one was given, otherwise the **first unchecked** `[ ]`
   item in `TODO.md`. Read its full text - the `TODO.md` entry names the branch and states the
   **done when**, and that sentence is the acceptance criterion for the whole iteration.
4. Every milestone above the item's is fully `[x]`. M2 work does not start with M1 half done.

Then: `git -c core.pager=cat -c core.hooksPath=/dev/null switch -c <branch-name-from-the-item>`.

## The pipeline

Run it as a single Workflow so each stage gets its own effort level and the security loop is
deterministic rather than model-judged. Pass the item as `args`.

```js
export const meta = {
  name: 'iterate',
  description: 'Code, test, refactor and security-gate one TODO item on its own branch',
  phases: [
    { title: 'Code' },
    { title: 'Test' },
    { title: 'Refactor' },
    { title: 'Security' },
    { title: 'Audit' },
  ],
}

// args arrives as an object or as a JSON string depending on how it was passed. Accept
// both: getting this wrong makes ITEM literally "undefined", and the coder then stops with
// no scope to work against - the right refusal, but a wasted round trip every iteration.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
const ITEM = A.item
const DONE_WHEN = A.doneWhen

if (!ITEM || !DONE_WHEN) {
  return { stopped: 'preflight', blockers: ['item and doneWhen must both be provided'] }
}
const PLANS = `
The plans in plans/ are the contract, not background reading. If the implementation needs a
shape they do not describe, STOP and say so - the rule is that a needed change edits the plan
first. Repo guardrails that are not negotiable: no emojis anywhere (code, comments, docs, commit
messages, UI); six runtime dependencies or fewer, and the budget is already spent, so any new
runtime dependency is a stop-and-ask rather than a judgement call; the status module and the wire
protocol get tests from the day they are written; nothing is vendored from an upstream we do not
maintain. Everything is developed and tested INSIDE the container - use
\`docker compose exec -T app ...\`, never the host toolchain.
`

const VERDICT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'summary', 'blockers'],
  additionalProperties: false,
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          failure_scenario: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'title', 'failure_scenario', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

// 1. Coder ------------------------------------------------------------------
phase('Code')
const coded = await agent(
  `Implement this backlog item and nothing adjacent to it.

ITEM: ${ITEM}
DONE WHEN: ${DONE_WHEN}

${PLANS}

Read the plans this item cites before writing anything. Implement only what the item scopes -
no speculative helpers, no abstractions for a second caller that does not exist, no error
handling for states that cannot occur. Commit your work on the current branch when it builds.
Return what you changed and anything the plans left genuinely undecided.`,
  { label: 'coder', effort: 'low', schema: VERDICT },
)

if (!coded?.ok) return { stopped: 'coder', blockers: coded?.blockers ?? ['coder returned nothing'] }

// 2. QA ---------------------------------------------------------------------
phase('Test')
const tested = await agent(
  `Write the tests for the work just committed on this branch.

ITEM: ${ITEM}
DONE WHEN: ${DONE_WHEN}

${PLANS}

The "done when" sentence is the acceptance criterion - there must be a test that demonstrates
it, and it must fail against the pre-change code. Cover the failure modes the plans call out by
name, not just the happy path: those are the cases the design exists to prevent, and they are
where being wrong is invisible from the outside. Where a plan says a behaviour was observed
rather than assumed, capture a fixture rather than hand-writing the expected payload.

Run the suite in the container. If a test fails because the implementation is wrong, do NOT
change the implementation to match your test - report it as a blocker. Commit the tests.`,
  { label: 'qa', effort: 'low', schema: VERDICT },
)

if (!tested?.ok) return { stopped: 'qa', blockers: tested?.blockers ?? ['qa returned nothing'] }

// 3. Refactor ---------------------------------------------------------------
phase('Refactor')
await agent(
  `Clean up the code on this branch. Behaviour must not change - the tests that pass now pass
after, unchanged.

${PLANS}

Look for: duplication that wants one implementation, type errors and \`any\` escapes, dead code,
names that do not match what the plans call the same concept, and comments that restate the line
below them. Match the surrounding code's idiom and comment density rather than imposing a style.
Do not add abstractions to remove duplication that appears twice - two is a coincidence.

Run typecheck, lint and the full suite in the container. Commit.`,
  { label: 'refactorer', effort: 'low', schema: VERDICT },
)

// 4. Security gate ----------------------------------------------------------
// Two review-and-fix rounds, then a whole-codebase pass. The loop is bounded here rather
// than left to the reviewer's judgement, so an iteration cannot spin.
phase('Security')
let open = []
for (let round = 1; round <= 2; round++) {
  const review = await agent(
    `Adversarially review the changes on this branch for security defects. Round ${round} of 2.

This is a terminal server: it is remote code execution by design, so the questions that matter
are what a remote caller can reach, what a compromised agent can reach, and what leaks. Read
plans/001 (authentication), plans/002 (the token asymmetry and the per-session secret) and
plans/005 (what containment does and does not buy) before judging anything - several apparent
holes are documented accepted risks, and reporting those as findings wastes a fix round.

Specifically check: secrets in logs, responses, error strings or files that get committed; the
user's bearer token being reachable anywhere an agent can read; \`cwd\` and path handling that
could escape the allowlist; anything taking a command line from a remote caller; token alphabets
and comparison; Origin and upgrade handling; and injection into anything shelled out to.

Report only defects you can name a concrete failure for. An accepted risk that the plans argue
for is not a finding.`,
    { label: `security:${round}`, effort: 'high', schema: FINDINGS },
  )

  open = (review?.findings ?? []).filter((f) => f.severity !== 'low')
  log(`security round ${round}: ${review?.findings?.length ?? 0} findings, ${open.length} actionable`)
  if (open.length === 0) break

  await agent(
    `Fix these security findings on this branch. Do not fix anything else.

${JSON.stringify(open, null, 2)}

${PLANS}

For each: fix the defect, add or extend a test that fails without the fix, and keep the fix
minimal. If you believe a finding is wrong or is an accepted risk the plans already argue for,
do not silently skip it - leave the code alone and say which one and why. Run the suite. Commit.`,
    { label: `fix:${round}`, effort: 'low', schema: VERDICT },
  )
}

// 5. Whole-codebase pass ----------------------------------------------------
// Not a re-review of the diff. The question here is what this change makes possible in
// combination with code it never touched.
// A fix round with no review after it proves nothing. Without this, `open` still holds the
// last round's findings when the loop exits, `clean` is false for any iteration that ever
// found anything, and the merge decision falls back to a human re-checking by hand - which
// is the work this gate exists to do.
if (open.length > 0) {
  const recheck = await agent(
    `Verify these findings are actually closed on this branch. Nothing else.

${JSON.stringify(open, null, 2)}

For each, read the current code and decide: closed, or still open. A finding the fixer said it
skipped as an accepted risk counts as CLOSED only if the plans genuinely argue for it - check,
do not take the claim. Return only the ones still open.`,
    { label: 'security:verify', effort: 'high', schema: FINDINGS },
  )
  open = (recheck?.findings ?? []).filter((f) => f.severity !== 'low')
  log(`verify: ${open.length} still open`)
}

// The audit runs last and has no fix round after it, so anything it finds is deferred work by
// construction. That is deliberate - its question is broader than one branch - but it means
// audit findings must never be read as "closed", and audit.md is a ledger of open items rather
// than a record of resolved ones.
phase('Audit')
const audit = await agent(
  `Final security pass. Do NOT re-review the diff in isolation - the previous rounds did that.

Review this branch's changes in relation to the ENTIRE codebase: what does this change make
reachable, in combination with code it did not touch? Trust boundaries newly crossed, an
allowlist now consulted from a second place, a secret that was process-local becoming file-local,
a route that was loopback-only now behind something that proxies.

Return every finding that remains, including ones you judge acceptable - this is the record, not
a gate. Mark severity honestly.`,
  { label: 'audit', effort: 'high', schema: FINDINGS },
)

return {
  item: ITEM,
  unresolved: open,
  audit: audit?.findings ?? [],
  clean: open.length === 0,
}
```

## After the workflow

1. **Read the returned object before doing anything.** If `stopped` is set, the branch is
   unmerged - report the blockers and stop. Do not merge past a stage that did not pass.
2. **Verify independently.** Run typecheck, lint and the suite yourself in the container. A
   subagent reporting `ok: true` is a claim, not evidence.
3. **Demonstrate the "done when".** Actually run it. If the item says a session survives a server
   restart, restart the server and list the session. Report what you saw, including the output.
4. **Decide the audit findings.** They have had no fix round - the audit runs last, so its
   findings are open by construction. For each: fix it on this branch if it is small and in
   scope, or record it in `audit.md` as deferred with the reason. A `high` is not deferred
   silently; either fix it or say plainly that you are merging with it open and why.
5. **Append to `audit.md`** - create it if absent. One section per iteration:
   ```
   ## <branch> - <date>
   <one line on what changed>
   ### Findings
   - [severity] file:line - title. Failure: ... Status: fixed in <sha> | accepted because ...
   ```
   An empty findings list is written as "None." rather than omitted; a missing section and a
   clean one must not look the same later.
6. **Tick the item** in `TODO.md`.
7. **Merge**, only if the gate came back clean and your own verification passed:
   `git -c core.pager=cat -c core.hooksPath=/dev/null switch main && git -c core.pager=cat -c
   core.hooksPath=/dev/null merge --no-ff <branch>`. Keep the branch.
8. **Do not push.** Plan 005's credential split is that the agent commits and the human pushes,
   and that applies to this pipeline too.

## Stop rather than proceed

- The coder found the plans do not describe the needed shape. Plans change first, by a person.
- A stage wants a new runtime dependency. The budget is spent; that is a line in a plan.
- Security findings survive both fix rounds. Report them, leave the branch, do not merge.
- The "done when" cannot be demonstrated. An item is not done because its code exists.
- Tests were changed to match the implementation rather than the other way round. Say so plainly.

Report what happened in a few sentences: the item, what landed, what the security gate found and
whether it was fixed or accepted, and the merge status. If anything was skipped, say which and
why - a partial iteration reported as complete is worse than one that stopped.
