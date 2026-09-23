---
name: creating-pull-requests
description: When to open a pull request in the DorkOS repo (review the pushed branch first, open the PR after it converges), how the automated review behaves (skip-review, review:light/deep, re-review), and how a PR lands through merge-tail and the merge queue, including what to do when it goes red or is ejected. Use when finishing a branch, opening a PR, deciding how much review a PR should get, requesting a re-review, or watching a PR until it merges.
---

# Creating Pull Requests

How DorkOS PRs are opened and how the automated Claude review behaves on them.
This repo is routinely multi-agent, so the mechanics below keep PRs clean and the
review loop cheap.

## When to use

- You have finished a branch and are deciding when to open the PR.
- You are about to open a PR (from an agent or by hand).
- A PR already has review feedback and you want another pass once it is addressed.
- You want to dial a PR's review up, down, or off.
- A PR of yours is red, ejected from the merge queue, or not merging, and you need
  to know whether acting helps or only adds load.

## The order: review the branch, then open the PR

The independent adversarial review runs **against a pushed branch, before a PR
exists**. Opening the PR is the last step, not the first:

1. Build in an isolated worktree and run the local gates.
2. Push the branch. **Open nothing.**
3. A reviewer fetches and checks out that branch. It does not need a PR.
4. Findings, fixes, convergence.
5. Squash to one clean commit carrying one changelog fragment.
6. **Then** open the PR, already reviewed, so the repo's automated review spends
   its single pass on final content.

Every reason below is a cost measured on 2026-07-27/28, not a preference:

- **Merge churn.** A PR held open across review rounds watches `main` move under
  it. One night of that took roughly a dozen branch updates (the pre-queue rule,
  retired 2026-07-28) and still left a `DIRTY` PR needing a semantic conflict
  resolved by hand.
- **The changelog gate.** A fragment claims the commits that existed when it was
  written. Review-fix commits arrive afterwards uncovered, and `fragment-present`
  fails. **Three PRs failed this way in one night.** One commit and one fragment
  removes the failure mode instead of working around it.
- **An open PR is an invitation to act.** Another session armed auto-merge on a PR
  carrying two open blocking findings. Both were browser-only and untested, so
  every check was green with the defects live. A branch invites nothing.
- **The automated review fires on open**, so opening early spends it on a draft.

The one real cost: **CI does not run until the PR opens.** Cover it two ways. Run
the local gates yourself, which is cheap (`pnpm verify`, plus the changelog gate
below). And when a runner-only check is the honest gate (smoke tests, the packaged
runtime, Docker, anything path-filtered to its own workflow), open a **draft** so
CI runs without inviting a merge, then mark ready once review converges.

## Before you open: branch from a worktree

Code PRs come from an isolated worktree, never the shared `main` checkout (see the
`working-in-worktrees` skill). Base the worktree on `origin/main`, not local
`main`, so the PR diff contains only your changes:

```bash
git fetch origin
git gtr new <branch> --from origin/main --yes   # the repo's worktree helper
```

Commit conventions and the pre-push gate live in the `git:commit` / `git:push`
commands. End commit messages with the `Co-Authored-By` trailer.

## Include a changelog fragment

A PR with user-facing changes must include a **changelog fragment** under
`changelog/unreleased/` — one file per change (`<YYMMDD-HHMMSS>-<slug>.md`; see
`changelog/README.md`). The `post-commit` hook usually writes one from your commit subject;
**verify it exists and curate it** (rewrite for a user, fix the category, add a `(#PR)` ref)
before opening the PR. Rewriting the prose is always safe: the PR check reads the fragment's
`covers:` frontmatter, not its wording. Write one by hand if the hook skipped it or phrased it
poorly, and give it a `covers:` line naming the commit. If you merge two fragments into one,
move the losing fragment's `covers:` items across. **Do NOT edit `CHANGELOG.md`'s
`[Unreleased]` section** — it no longer holds entries; only `/system:release` writes
`CHANGELOG.md`.

**Two habits stop the gate from turning red days later** (it hit five PRs in one week:
#1510, #1567, #1581, #1618, #1700). (a) A commit that genuinely isn't user-facing — a
review-nit fold, a refactor, a CI tweak — takes a `chore(` or `ci(` subject, so the
populator mints no stub at all. (b) A user-facing commit curates its seeded stub in the
**same commit that creates it** — rewrite the bullet for a human, delete the seeded
comment — never leaving it for CI to catch. If a curated fragment for the batch already
exists, fold the stub's `covers:` line into it byte-for-byte and delete the stub. Full
mechanics: `changelog/README.md#seeded-fragments`.

**The `skip-changelog` label race, and the fix that is not an empty commit.**
`gh pr create --label skip-changelog` can lose a race: the `opened` run of
`fragment-present` reads labels from its event payload, which can be captured before
the label attaches, so coverage runs and fails a PR whose commits are typed `feat(` or
`fix(`. Two reflexes make it worse. A re-run replays the same stale payload (on #768,
attempt 2 of the failed run failed again), and toggling the label starts an
`unlabeled` run with no label that fails on the same SHA. Every failed run on the head
SHA stays in the rollup, so only a new head clears it, and that head should be a real
fix, never an empty commit:

- **Not user-facing** (what the label claims): reword the commit to `chore(`, `ci(`
  or `docs(` (`git commit --amend`, then `git push --force-with-lease`). Coverage
  then passes with or without the label, so the race cannot bite again.
- **User-facing after all**: the label is wrong. Remove it and add the fragment.

Prevention is the same move up front: type a non-user-facing commit `chore(` or
`ci(` before you open the PR.

### Run the changelog gate locally

The gate is not "is there a fragment". It is "**is every user-facing commit claimed
by some fragment's `covers:` list**". Reproduce it before you push:

```bash
python3 .claude/scripts/changelog_backfill.py --since "$(git merge-base origin/main HEAD)" --validate --changed-only
python3 .claude/scripts/changelog_backfill.py --since "$(git merge-base origin/main HEAD)" --pr <n> --check --changed-only
```

The first checks that the fragments you touched are well formed; the second checks
coverage. Each prints a one-line verdict and exits non-zero on failure, and the
failure names the uncovered commits and shows the fragment that would cover them.
Drop `--pr <n>` before the PR exists: it only matters when a fragment claims a
whole PR by number (`- "#412"`).

The failure mode to watch: a fragment written with the first commit does not cover
commits added later, so **a PR that was green turns red the moment it takes review
feedback**. The fix is a `covers:` frontmatter block naming each commit's subject
line verbatim:

<!-- The double quotes are load-bearing: verbatim what the post-commit hook writes.
     Prettier rewrites quotes inside an embedded fence, hence the ignore. -->
<!-- prettier-ignore -->
```markdown
---
covers:
  - "fix(relay): stop a Telegram bot answering other bots and every group message"
  - "fix(relay): treat an anonymous Telegram admin as a person"
---
```

`covers:` exists precisely so the prose can be written for a human without breaking
the check. Squashing to one commit before opening the PR makes the whole problem
disappear, which is the deeper reason for the order above.

## Pipeline-touching PRs need a ledger entry

A PR that changes the CI pipeline is an experiment, and CI Steward keeps the record.
Start with `/ci-status` (`pnpm ci:status`): it names the current constraint, the SLOs
and every open experiment's verdict, which is where a baseline comes from and whether
another change is already moving the gate you want to touch. If your diff touches a gate source (`.github/workflows/**`, `lefthook.yml`,
`turbo.json`, `.claude/settings.json`, `ci/**`, a script a gate invokes,
`packages/ci-steward/src/**`, or this skill with its watcher; the coverage step's exact
set comes from the census, and `.claude/rules/ci-pipeline.md` loads for a superset of
it), add or edit one file under `ci/ledger/` in the same squashed commit.

- Scaffold one: `node packages/ci-steward/src/cli.ts ledger-new --slug <slug>` (`--help`
  lists its flags). Check it: `node packages/ci-steward/src/cli.ts ledger-check`. The
  PR-only coverage question is
  `node packages/ci-steward/src/cli.ts ledger-check --coverage --base "$(git merge-base origin/main HEAD)"`.
- **A pipeline change carries a hypothesis.** `kind:` is `experiment`,
  `incident-fix` or `hygiene`, and every kind but `hygiene` names one metric, a
  baseline, a target and `after_days`. "Faster CI" is not a hypothesis; "this gate's
  p90 goes from 14 to 8 minutes within 14 days" is. Copy the baseline from
  `/ci-status` and say where it came from (`baseline_source:`).
- **Ratchet releases block review by default.** An entry that lowers a quality floor
  (a `ratchet-release`, enforced from phase 2) needs a specific reason, or the review
  treats it as blocking.
- Never write `verified`, `partial`, `failed` or `inconclusive` as a status. Those
  are verdicts the machine computes, and the ledger check rejects them on `main`.
- The coverage step ("CI Steward ledger coverage" in the required `typecheck` job)
  fails the PR when a pipeline change has no ledger entry.

The full protocol is in `contributing/ci.md` and the `stewarding-ci-pipeline` skill.

## Opening the PR

Open it once the branch has converged, with the squashed commit and its fragment
already pushed:

```bash
gh pr create --title "<type>(<scope>): <summary>" --body "<body>"
```

PR body: lead with what changed and why, link the spec or issue, and call out
anything reviewers should look at first.

Open a **draft** instead when you still need CI to tell you something, then mark it
ready once review converges:

```bash
gh pr create --draft --title "<type>(<scope>): <summary>" --body "<body>"
gh pr ready <number>        # marking ready fires exactly one full review
```

A draft gets no automatic review, so you can push to it freely; marking ready
triggers one review of the final state.

### A merged PR closes the ticket it names — from the title, the branch, or a magic word

Linear's GitHub integration moves an issue on PR lifecycle: In Progress on open,
Done on merge. It never reads the diff to check whether the work is actually
finished. There are three ways a PR names a ticket and they do not behave alike:

| Where the identifier appears                                           | On merge               |
| ---------------------------------------------------------------------- | ---------------------- |
| A bare id in the **title** or the **branch name**                      | **Closes** the ticket  |
| A **magic word** anywhere, body included — `Closes`/`Fixes`/`Resolves` | **Closes** the ticket  |
| A **bare id in the body**, or `Refs DOR-634`                           | Links only, stays open |

So **match what you write to the truth — say "closes" only when the PR completes
the ticket.** A PR that advances a ticket without finishing it keeps the bare
identifier out of the title _and_ the branch name, and refers to it from the body in
a form that does not close: a bare id, or `Refs DOR-634`.

**The body is not automatically safe, and this repo's own habit is the trap.** House
style for a PR body is a closing magic word — 15 of the last 60 merged PRs use one,
including #589, whose body opens `Closes DOR-661.` So an author who dutifully moves
the identifier out of the title and then writes the body sentence everyone else
writes reproduces the exact failure this rule exists to prevent, while believing
they followed it.

The split is visible in the repo's own history: the magic-word PRs above all closed
their tickets, while every ticket referenced by a **bare** id in a merged body is
still open (DOR-592, DOR-666, DOR-668, DOR-669, DOR-671).

Two tickets were closed by their titles on 2026-07-28, and both had to be reopened
by hand with the cause recorded on the ticket:

- **DOR-591** is a **code** ticket — the CommunityAdapter interface and its
  conformance suite. A PR titled `docs(spec): … (DOR-591)` delivered only the
  _specification_, and still moved it to In Progress on open and Done on merge.
  It was the **second** time that ticket had been closed this way.
- **DOR-634** was closed outright by the first PR to carry it, titled
  `feat(rooms): … (DOR-634)`, which delivered only the server half while the client
  and migration work was still unwritten.

The corollary matters as much: when the PR genuinely completes the ticket, the
identifier in the title is doing exactly what you want and saves you the
transition. The rule is about what you write telling the truth, not about avoiding
identifiers.

Branch names carry the same force, so the choice is made before the PR exists — see
`working-in-worktrees` → **Create the worktree**.

## How the automated review behaves

The `claude-code-review` workflow reviews **on-demand, not on every push**:

| Event                         | Review?                                       |
| ----------------------------- | --------------------------------------------- |
| PR opened (non-draft)         | One full review                               |
| Draft marked ready-for-review | One full review of the final state            |
| New commits pushed            | **No** auto-review (CI tests still run)       |
| `re-review` label applied     | One re-review, scoped to the delta            |
| PR has merge conflicts        | **Nothing runs at all** — see below           |
| PR edits this review workflow | Auto-run red; manual review works — see below |

This mirrors how human teams work: pushes are work-in-progress, and the author
pulls the reviewer back in with an explicit "ready again" signal. It avoids
re-reviewing five or six times while you address feedback.

**You no longer lose the review by creating a PR with labels on it.** Until
2026-09-20, `gh pr create --label ...` fired `opened` plus one `labeled` event
per label within the same second; the labeled runs evicted the still-pending
`opened` run from its concurrency group and then skipped, so about 3% of merged
PRs were never reviewed and nothing was red. Runs that will not review now sit in
their own group and cannot evict one that will, and the group is keyed by head
SHA, so one commit gets exactly one review.

**A review lost to an infrastructure failure is re-requested for you.**
merge-tail applies `re-review` on your behalf when the check is red, up to three
times per head SHA (`scripts/should-redispatch-review.sh`). Do not wait on it if
you want a review now: GitHub throttles scheduled workflows and the median gap
between merge-tail ticks is about 2.7 hours, so apply `re-review` yourself. It
leaves a `skip-review` label alone, never retries a PR that edits the review
workflow (that one cannot be reviewed by it at all), and waits out the Claude
subscription window when the last attempt died against a quota (about 5 hours,
6 for a weekly limit) before trying again — a pause, not a give-up. If your PR is conflicting and `re-review` seems stuck on it, merge-tail
removes it for you — a conflicting PR produces no run, so nothing else can.

## Rebase before you expect a review

**A pull request with merge conflicts gets no CI at all — no review, and no red
check to tell you so.** GitHub builds a PR's test-merge commit before it starts any
`pull_request` workflow. When the branch conflicts with `main`, that commit cannot
be built, so GitHub starts nothing: no run, no failure, no entry in the Actions
list. The PR looks reviewed and clean because nothing ever looked at it. This hits
every check in the repo at once, not just the review, and no amount of re-labelling
or toggling draft will shake a run loose.

So: **rebase onto `origin/main` and push before you open the PR, and again before
you ask for a review.** If GitHub's PR page says the branch has conflicts, treat
every green space on that page as meaningless.

**An auto-merge armed on a conflicting PR is the same silence, one step later.** It
waits on checks that will never run, so it never fires, and nothing tells you it is
stuck. It just sits there looking armed.

If you need a review without rebasing first, run the workflow by hand:

```bash
gh workflow run claude-code-review.yml -f pr=<number>
```

Manual dispatch reviews the PR's head directly. It ignores `skip-review` and draft
state (you asked for it explicitly), refuses fork PRs, and clears `re-review` if
the PR is carrying it.

**Since the concurrency rework it runs _beside_ an automatic review rather than
replacing one.** A dispatch has no head SHA in its payload, so it is keyed by PR
number and shares no group with the automatic run. If a review is already in
flight, dispatching gets you two reviewers, two verdicts and double the
subscription spend. Check for a running `review` check first; the hatch exists
for PRs that have no run at all.

Two more differences from an automatic run, because the Claude action treats a
manual trigger as having no PR identity:

- It posts its line-level findings through the GitHub API instead of the action's
  inline-comment tool. Same result, slightly more turns spent.
- It reverts `.claude/`, `.mcp.json`, `CLAUDE.md` and `.husky` in the checkout to
  the `main` versions before reviewing, so a PR can never make its own reviewer run
  hooks the PR wrote. The reviewer still reads those changes from the diff. (An
  automatic run gets the same protection from the action itself.)

That trusted `main` workflow can review a PR that edits
`.github/workflows/claude-code-review.yml` and post its verdict. It does not run the
PR's proposed workflow or final gate. The automatic run still proves the proposed
gate fails closed when validation blocks the review. Dispatch again after the
change lands to prove the successful-review path under the merged gate.

A dispatch also cancels an automatic review already running on the same PR, and
gets cancelled by the next automatic trigger — the newest request wins.

## Review-control labels

| Label          | Effect                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `skip-review`  | No automatic review at all. Apply **at open** (the workflow checks labels on the triggering event).                                 |
| `review:light` | Quick pass: only Important findings; skips nits and the deletion sweep.                                                             |
| `review:deep`  | Exhaustive: traces every caller, runs the full dangling-reference sweep.                                                            |
| `re-review`    | Request another pass after addressing feedback. Auto-cleared after the review runs, so re-apply it each time you want another look. |

Apply at creation so the `opened` event sees them:

```bash
gh pr create --draft --label review:light --title "..." --body "..."
```

Request a re-review after pushing fixes:

```bash
gh pr edit <number> --add-label re-review
# or, ad hoc, comment `@claude take another look` (handled by claude.yml)
```

Guidance: reach for `skip-review` only on genuinely trivial PRs (typo, version
bump) where you are the merger and have full context. Prefer `review:light` over
`skip-review` when in doubt: you still get Important-only coverage at low cost.
Use `review:deep` for risky changes (security, migrations, broad refactors,
deletions).

## Merging: you arm it, the queue lands it

`main` merges through a merge queue (ADR 260728-112203). GitHub builds each queued PR
on top of `main` plus everything ahead of it in the queue, runs the required checks on
that combined tree, and merges only if they pass. Being behind `main` blocks nothing,
so **never update a branch to satisfy a gate**: no `gh pr update-branch`, no merging
`main` in to be current. It starts a fresh round of 19 to 25 Actions jobs against a
60-job pool every agent shares, and it disarms the PR.

**Who arms it.** `merge-tail.yml` arms auto-merge on every finished PR, but GitHub
throttles its `*/10` schedule: over 200 scheduled runs (2026-08-25 to 09-19) the median
gap was 162 minutes and the p90 305, so it runs roughly every 2-3 hours, not every 10
minutes. It is a backstop. It arms a PR that is open, not a draft, no hold label (`hold`, `do-not-merge`, `wip`,
`blocked`), not conflicting, no requested changes, no unresolved review threads
(outdated ones count), and every check settled green with none cancelled. It will not
re-arm a PR the queue has rejected twice for the same check on the same head commit;
it comments on the PR once instead, and a new commit clears it. The decision
is `scripts/should-arm-automerge.sh`. Arm your own green PR yourself instead of
waiting for it; arming is idempotent and safe (one arming path arrives in phase 1b):

```bash
gh pr merge --auto <number>
```

Leave off the strategy flag; the queue owns it. `gh pr merge --auto --squash` prints
`! The merge strategy for main is set by the merge queue`, which reads like a refusal
and is not (the PR was enqueued, and a repeat call answers "already queued").
`--delete-branch` is rejected outright. Confirm with `gh pr view <n>` rather than
reacting to stderr.

**What an armed PR does not wait for.** Once armed, GitHub waits only on the required
checks. The Claude review is not a required check and conversation resolution is off,
so on an armed PR a red review or an open thread blocks nothing. Only merge-tail's own
arming respects them. That is why the order at the top of this file (review the
branch, then open the PR) is the safeguard that actually holds: arm at creation only a
branch that has already converged.

**A new commit disarms auto-merge.** GitHub drops the armed state on every push to
the PR branch, silently. Re-arm it yourself once the new commit's checks are green;
merge-tail's next run may be hours away.

**Never an admin merge.** `gh pr merge --admin`, a REST `PUT .../pulls/<n>/merge` and
the `mergePullRequest` mutation each land a change without the queue's checks, and
every agent on this machine runs as an admin. In Claude Code the PreToolUse guard
`.claude/hooks/merge-guard.mjs` refuses them. Other harnesses may not run it (Codex
reads a generated, trust-gated `.codex/hooks.json`, unverified for this guard), so
there treat this sentence as the whole rule. Admin merges are reserved for the CI Steward
break-glass path (`/ci-break-glass`, phase 1b, not built yet); see `contributing/ci.md`.

**Arming is not the same as walking away.** Read the next section before you treat
an armed PR as finished.

### The merge lands after your session ends, so clean up on your next visit

Auto-merge and the merge queue both land the PR minutes to hours after you arm it.
Whatever cleanup you were planning to do "once it merges" will therefore be
proposed to nobody: the session that opened the PR is usually gone. Do not leave
the worktree removal as a promise to your future self.

GitHub deletes the branch on origin by itself (the repo has "automatically delete
head branches" on). Your local worktree and local branch it cannot see, so those
are yours to collect:

```bash
bash scripts/worktree-janitor.sh          # what would go, and why
bash scripts/worktree-janitor.sh --fix    # remove it
```

Run it at the start of a working session rather than the end of one — that way it
collects the PRs that merged while you were away, which is most of them. It only
removes what it can prove is safe, which is exactly two shapes:

- a branch whose pull request merged **and** whose tip has not moved since (a
  later push means work `main` has never seen); or
- a checkout whose every commit is already on origin **and** whose name origin no
  longer carries — both halves, because "every commit is on origin" on its own
  also describes a branch you pushed and have not opened a PR for yet.

Anything uncommitted, unpushed, still open, or unaskable is left alone with a
reason. If it cannot reach GitHub it reports `pr-state-unknown` for every branch
and removes nothing.

On 2026-08-01 the accumulated cost of not doing this was 116 worktrees at ~3.5 GB
each, 193 local branches, and 414 branches on origin, against 5 open PRs. Method
and per-item record: `research/20260801_worktree-and-branch-sweep.md`.

### Which checks are required

**Only people with write access can arm a PR.** In GitHub's words: "People with write
permissions to a repository can enable auto-merge for a pull request." An outside
contributor on a fork PR cannot arm their own merge.

**Ask the repo which checks are required; never assume.** Ruleset 19893973 is the only
protection on `main` (classic branch protection was retired on 2026-09-19), so ask the
rules API:

```bash
gh api repos/{owner}/{repo}/rules/branches/main \
  --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```

The older `gh api repos/{owner}/{repo}/branches/main/protection` read the classic
protection only. It returned 6 of the 9 required checks and missed `test`, `lint` and
`credential-free-build`, so an agent trusting it would ignore a red required check.
Today's list, generated from `ci/required-checks.json` (the CI Steward census checks
this block byte for byte, so it cannot drift quietly):

<!-- The block below is generated from ci/required-checks.json and checked byte for byte
     by the CI Steward census; prettier would add blank lines inside it, hence the ignore. -->
<!-- prettier-ignore-start -->
<!-- ci-steward:required-checks:start -->
- `typecheck`
- `fragment-present`
- `no-fragment-under-skip-label`
- `version-outranks-base`
- `test`
- `browser-test`
- `lint`
- `credential-free-build`
- `db-check`
<!-- ci-steward:required-checks:end -->
<!-- prettier-ignore-end -->

**Never require a check whose workflow has a `paths:` filter.** That workflow does
not run on a PR that touches nothing under those paths, and GitHub leaves the check
pending rather than skipping it: "If a workflow is skipped due to path filtering,
branch filtering or a commit message, then checks associated with that workflow
will remain in a 'Pending' state. A pull request that requires those checks to be
successful will be blocked from merging." An auto-merge armed on such a PR waits
forever too. The census now fails any required check whose workflow has a `paths:`
filter or does not run on both `pull_request` and `merge_group` (the deadlock
invariant in `contributing/ci.md`).

### Watching an armed PR: watch the checks, not the merge state

Another silent stall, and the easiest to inflict on yourself. Once a PR is armed
you will wait for it, and the obvious poll — "has it merged yet?" — is blind to the
one outcome you most need to catch:

```bash
gh pr view <number> --json state --jq .state   # OPEN until MERGED/CLOSED — says NOTHING about a failed check
```

A required check that **fails** leaves the PR `OPEN` and unmerged, indistinguishable
from a PR whose checks are still running. A merge-state poll loops until its own
timeout while the PR sits dead and reports nothing wrong — because from its narrow
view nothing is: GitHub is fine, the PR is not. Watch the check **conclusions**
instead:

```bash
gh pr checks <number>                                   # one bucket per check: pass | fail | pending | skipping
gh pr view <number> --json statusCheckRollup --jq \
  '[.statusCheckRollup[] | select(.conclusion=="FAILURE") | .name]'   # the failures, by name
```

**Separate a required failure from a standing red.** Not every red check blocks the
merge, and not every red check is yours. `Vercel`'s preview deploy is frequently red
on `main` itself; a check that fails identically on the last few `main` commits is a
standing condition, not something this PR broke, and it is not in the required set
the merge queue gates on. Chasing it burns the attention the actually-blocking check
needs. Confirm the required set (the rules API command above), then act only on a
**required** check that went red on **this** PR.

**Do not write the watch loop from memory; run the tested one:**

```bash
.agents/skills/creating-pull-requests/scripts/watch-prs.sh --interval 120 <number> [<number>...]
# pipe it into the Monitor tool for hands-free notification; --once for a single cycle
```

Every watcher on this machine spends the operator's one GraphQL budget (5,000 points
an hour, shared with merge-tail), so poll no faster than you need: 120 seconds is
plenty for a PR whose checks take 15 to 40 minutes.

It reports state **transitions** (never a once-per-PR "seen" flag that goes blind
after the first event; a watcher written that way missed a check failure on
2026-08-24). Each line that asks something of you ends in ` :: <remedy>`, the exact
next step, so a Monitor-woken agent does not have to re-read this file. The
vocabulary, the remedy text and the collector are pinned by
`scripts/test-watch-prs.sh`; the header of `watch-prs.sh` is the reference. In
precedence order:

| Token                             | What it means                                                                                   | Who acts                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| `MERGED`, `CLOSED`                | Terminal                                                                                        | nobody                     |
| `EJECTED(reason)`                 | The queue dropped the PR (only the `REMOVED_FROM_MERGE_QUEUE_EVENT` timeline item records this) | depends on the reason      |
| `EJECTED_REPEAT(failed_checks,k)` | k failed-checks ejections with no new commit in between                                         | you: is it the same job?   |
| `CONFLICTING`                     | Needs a rebase; a conflicting PR runs no CI and no review                                       | you                        |
| `FAILING(names)`                  | PR checks red (standing `Vercel` reds excluded)                                                 | you, after reading the log |
| `CANCELLED(names)`                | A cancelled check; merge-tail never arms a PR carrying one                                      | you: re-run it once        |
| `STUCK_UNMERGEABLE`               | A dead queue entry that keeps its position                                                      | you, after 10 minutes      |
| `STALLED_IN_QUEUE(m)`             | Queued for 90 minutes or more (the queue's p90 is about 55)                                     | nobody on your branch      |
| `HELD_BY_LABEL(l[,armed])`        | A hold label is on it; `,armed` means it was armed anyway and the queue does not read labels    | whoever set the label      |
| `UNRESOLVED_THREADS(n[,armed])`   | Open threads, outdated included; `,armed` means it will merge with them open                    | you                        |
| `UNARMED_CLEAN`                   | Green and unarmed                                                                               | merge-tail, within 10 min  |
| `QUEUED(pos)`, `PENDING`          | Informational                                                                                   | nobody                     |
| `RECOVERED`                       | Healthy again after a red, cancelled, stuck, stalled or blind state                             | nobody                     |
| `WATCHER BLIND(k cycles)`         | Its `gh` calls failed k cycles running (auth, network, rate limit)                              | you: `gh auth status`      |

Semantics it gets right that ad-hoc loops get wrong: `mergeStateStatus: UNKNOWN` is
retry-not-terminal (mergeability is computed async); checks attach to the head SHA,
so the rollup stays correct across reruns; `gh pr checks` never shows merge-group
runs, so queue trouble is read from the queue entry and the timeline, not from check
rows (the old `STALLED_IN_QUEUE` test counted check rows and could never fire); and a
`hold` label beats "green and unarmed" (the old `UNARMED_CLEAN` remedy said to merge
directly, which walked straight past a hold).

On 2026-08-06 the v0.58.0 release PR sat `OPEN` with a red **required** `typecheck`
(its prettier `--check` step — see the worktree gotcha below), while a
merge-state-only poll reported nothing and would have run clean to timeout. The fix
was not a shorter poll interval; it was polling the right field.

The `Monitor` tool version of this loop fails the same way when written from
memory. On 2026-08-12, PR #982 sat four hours behind one flaked `browser-test`
while its watcher reported healthy: its terminal conditions — merged, closed,
unresolved-threads-appeared, kicked-from-the-merge-queue — all stay quiet on a red
check, because a PR with a failed required check never enters the queue at all.
Three rules for any PR watcher, Monitor or bash:

- **A failed non-`Vercel` check conclusion must be a terminal condition.** A
  watcher without one cannot see the most common stall, however many other
  signals it carries.
- **"Auto-merge armed and zero unresolved threads" proves nothing about checks.**
  It is exactly the state every stuck PR was in when it got stuck.
- **A watcher that dies, or goes blind, must say so.** `watch-prs.sh --max-cycles N`
  announces its own expiry (exit 3), and three failed `gh` cycles in a row print
  `WATCHER BLIND` once instead of silence; keep that shape, and answer it. An armed
  PR that outlives its watcher deserves a direct `gh pr checks` look, whatever the
  watcher reported.

Note the shape of the traps together: a **conflicting** PR runs nothing, a PR missing
a **path-filtered** required check hangs pending, a **held** PR is green and will
never be armed, and a **failed-check** PR reads exactly like a slow one. All of them
look like a PR that is fine.

### Red or ejected: wait first, act once

Twenty agents following one remedy at the same moment is the normal case here, not
the edge case. One push to a PR starts 19 to 25 Actions jobs against a 60-job pool
(the org is on the GitHub Team plan), so twenty pushes put 400 to 500 jobs in line,
and the merge queue's own builds wait behind them. So every remedy below is the
cheapest one that works, and none of them is an empty commit. An empty commit costs a
full CI round, disarms the PR, and makes CI Steward score a flaky ejection as a real
catch, which corrupts the numbers the pipeline is tuned by.

- **`EJECTED(failed_checks)`, the first time: do nothing to the branch.** 85% of
  failed-checks ejections (209 of 247 over 30 days) passed with no change on
  re-entry. Do not push and do not rerun. Read the failing merge-group job first: if
  it covers a package you changed, run its tests locally (`pnpm vitest run <path>`)
  and fix only if they fail. Once the evidence says it is not yours (the same job red
  on `main` or in other groups, or a flake or infra error in its log), re-arm it
  **once** yourself with `gh pr merge --auto <n>`. Green PR checks are not that
  evidence: the browser tests run only in the queue, so a PR that breaks one reads
  green everywhere else.
- **`EJECTED_REPEAT(failed_checks,k)`: stop re-arming.** If the **same check** failed
  again on the **same head commit**, it is a regression only the queue can see, not a
  flake. Do not re-arm. Find the job in each merge-group run
  (`gh run list --event merge_group -L 100 --json headBranch,name,conclusion,databaseId`,
  keeping rows whose `headBranch` contains `pr-<n>-`), read its log, fix it, push.
  merge-tail will not re-arm such a PR either: it comments once and waits for a new
  commit. PR #1964 was re-armed unchanged four times after the same browser assertion
  failed, costing 17 queue builds, its own and every PR stacked behind it. The one
  exception is the same check red on `main` too (a break that landed there, like the
  wall-clock fixture of 2026-09-17): wait for the fix on `main`, then re-arm. Different
  checks each time: still likely flaky; re-arm with `gh pr merge --auto <n>`.
- **`EJECTED(merge_conflict)`** (or `invalid_merge_commit`, `git_tree_invalid`):
  rebase onto `origin/main` and push once. **`EJECTED(manual)`**: someone removed
  it on purpose; read the timeline before re-arming. **`EJECTED(checks_timed_out)`**
  and **`STALLED_IN_QUEUE`**: a queue or runner stall, not your PR; do nothing to the
  branch and check githubstatus.com if it repeats.
- **`FAILING` on the PR: read the log first.** Caused by your change: fix and push.
  Not yours (the same job is red on `main` or on other PRs, or the log shows an infra
  error such as a lost runner): `gh run rerun <run-id> --failed`, once. If `main` was
  broken when the check ran and is fixed now, rebase onto `origin/main` and push
  once: a rerun replays the original merge commit, so it cannot pick up the fix.
- **`CANCELLED`**: re-run the cancelled run once (`gh run rerun <run-id>`); merge-tail
  will not arm the PR while it stands.
- **`UNARMED_CLEAN`**: arm it now with `gh pr merge --auto <n>`. Never merge it
  directly. (Waiting for merge-tail made sense when it was believed to run every 10
  minutes; it runs every 2-3 hours.)
- **`HELD_BY_LABEL`**: not yours to lift unless you added the label.

### Clearing a STUCK_UNMERGEABLE queue entry

The merge queue can leave a PR's entry in the state `UNMERGEABLE`: it is still in
the queue and still shows a position, but the queue will never merge it. Because
the position is there, a naive watcher reads it as a healthy `QUEUED` — the false
green `STUCK_UNMERGEABLE` exists to catch. Nothing else surfaces it either: a
queued PR reports `autoMergeRequest: null`, so it does not look armed, and
`gh pr merge --auto` just says "already queued" and changes nothing.

Give it a dwell first: `UNMERGEABLE` can be the passing state an entry goes through
between a failed group and its ejection, so act only when it is still there after
about 10 minutes, and never while the queue is in an incident (many PRs ejected or
stalled at once), when dequeues fight the recovery.

The fix is to take the PR out of the queue and put it back. Removing it uses the
GraphQL `dequeuePullRequest` mutation. Introspecting the live GitHub GraphQL
schema on 2026-08-27 confirmed its input type is
`DequeuePullRequestInput { id: ID!, clientMutationId: String }` — the required
`id` is the PR's **node id**, not its number — and it returns a
`DequeuePullRequestPayload { mergeQueueEntry, clientMutationId }`. Get the node id
from `gh pr view <n> --json id`, then re-arm auto-merge so it re-enters the queue
from a clean start:

```bash
PR_ID=$(gh pr view <number> --json id --jq .id)
gh api graphql -f query='
  mutation($id:ID!){ dequeuePullRequest(input:{id:$id}){ mergeQueueEntry { position } } }' \
  -f id="$PR_ID"
gh pr merge --auto <number>   # re-arm; it rejoins the queue from a clean start
```

The watcher stays read-only — it reports `STUCK_UNMERGEABLE` and never mutates.
Clearing the entry is a deliberate, separate step you run by hand.

## Stacked branches and squash merges

Two recurring conflict shapes when several branches share files and `main` merges
by squash, each with a recipe that has worked repeatedly:

- **Your own squashed base conflicts with you.** A branch stacked on another
  branch (or on its own earlier PR) hits "changed in both" conflicts against the
  squash commit, with byte-identical content on both sides. Pin the base first —
  `BASE=$(git rev-parse origin/main)` — then verify each conflicted file is
  identical between the merge base and `$BASE`
  (`git diff <base>:<file> "$BASE":<file>` — empty means the conflict is pure
  squash noise), then keep the branch side wholesale. Write files out with
  `git show HEAD:<file> > <file>` — `git checkout -- <path>` is hook-banned here.
  Confirm with a three-dot diff against `$BASE` showing only the branch's own work.
  **Reuse `$BASE`; never name `origin/main` twice in one comparison** — worktrees
  isolate working trees, not refs, so another session's `git fetch` moves it
  between your commands and nothing errors. See `working-in-worktrees` →
  _Two readers, one ref namespace_.
- **A textually clean merge is not a semantically clean one.** When sibling
  branches landed on one seam, `git merge origin/main` can resolve cleanly while
  leaving a new route calling a renamed helper, tests asserting copy another PR
  changed, or a doc paragraph another PR made false. After merging `main` into any
  branch whose neighbours touched the same area: run the typecheck, run the
  neighbouring tests, and regenerate anything derived (OpenAPI export, generated
  docs) before pushing.

**A push is not landed until the remote says so.** A compound command ending in
`; echo ...` exits 0 whatever the push did, so a refused pre-push hook reads as
success — three false "pushed" reports in one night (2026-08-11). Confirm with
`git ls-remote origin <branch>` showing the SHA; a remote-ref probe cannot report
a false success.

## One-time repo setup

The four labels must exist in the repo before they can be applied. Create them
once:

```bash
gh label create skip-review  --description "Skip the automated Claude review"      --color ededed
gh label create review:light --description "Quick review: Important findings only" --color fbca04
gh label create review:deep  --description "Exhaustive review"                     --color b60205
gh label create re-review    --description "Request another automated review pass" --color 0e8a16
```

## Gotchas

- **A `git push` killed at the tool ceiling did not necessarily fail.** The pre-push
  test gate can outlast a 10-minute tool call; the kill takes the hook with it, and
  CI Steward counts it as a killed `local-push` run: at once when the kill was a TERM,
  INT or HUP (the time-wrap writes its END with 128+n), and only after the pre-push
  watchdog's 2-hour ceiling when it was a SIGKILL, which leaves no END, because until
  then the push might still be running. First check whether the push landed (`git ls-remote origin <branch>` against
  `git rev-parse HEAD`). If it did not, push again in the background or with a longer
  timeout rather than reaching for `--no-verify`: CI runs every gate anyway, but a
  `--no-verify` push is invisible to the timing that would show the gate needs
  bounding (the seeded `pre-push bounded to about two minutes` experiment).

- **A commit made in a fresh worktree bypasses lefthook, so its formatting is never
  auto-applied.** The pre-commit and pre-push hooks shell out to `prettier`, `turbo`,
  and `dotenv` from `node_modules`, which a just-created worktree does not have — so
  lefthook either is not on `PATH` ("Can't find lefthook in PATH", hook silently
  skipped) or runs and dies on the missing binaries. Either way the format the hook
  would have applied never happens, and CI's `prettier --check` step (inside the
  required `typecheck` job) then fails on drift you never saw locally. It bites
  machine-generated JSON most — a regenerated manifest, a written-out coverage map —
  since hand-written Markdown passes untouched (`proseWrap: preserve`). Before pushing
  from a worktree that has no `node_modules`, format the changed files with a checkout
  that does, then re-check:

  ```bash
  # from the primary checkout (which HAS node_modules), pointing at the worktree's files
  ./node_modules/.bin/prettier --write <changed-files-under-the-worktree>
  ```

  If the dead hook also blocks the commit or push itself (it runs `lint`/`test` and
  fails on the missing `turbo`), pass `--no-verify` — CI runs the real gates on the
  PR regardless. This is exactly what reddened the v0.58.0 release `typecheck`.

- **Editing the automated-review workflow makes its automatic run fail closed.**
  The Claude action refuses to start unless the workflow file it is running from
  matches the copy on `main` — otherwise a PR could rewrite the workflow to steal
  the token — and the action itself exits successfully. For
  `.github/workflows/claude-code-review.yml`, the always-running verdict gate sees
  that no review was posted and makes the check red. A manual dispatch uses the
  trusted workflow from `main`, so it can still review the PR's head and post a
  verdict without executing the PR's proposed workflow. The automatic run exercises
  the proposed gate's fail-closed path; after the merge, dispatch against a real PR
  again to prove the successful-review path under the merged version:
  `gh workflow run claude-code-review.yml -f pr=<number>`. The guard is per file:
  editing `.github/workflows/claude.yml` can silence `@claude` on that PR without
  disabling `claude-code-review`, and vice versa.
- **A finished review is a green check, even when the action failed.** The action
  re-counts turns after the run and fails the step if a clean run overshot
  `--max-turns` — which used to red a review that had already posted its findings
  and its tally, and merge-tail will not arm a PR with a red check. It no longer
  does: when the review finished and its verdict is on the PR, the check goes green
  and you get no comment at all, just a warning annotation on the Actions run
  (DOR-1665). So a green `claude-code-review` check means the current run posted a
  recognized verdict. A conflicting PR has no automatic run at all, while a PR
  editing this review workflow gets a red automatic check and needs the trusted
  manual dispatch described above.
- **A red review check is not always a finding.** When the review breaks in a way
  that cost you the verdict, it posts a comment saying so and naming which of six
  things happened:
  - **This PR edits the review workflow.** The action refuses to run from a copy
    of its own workflow that differs from `main` — a pull request must not be
    able to rewrite the file holding the reviewer's credentials — so it exits in
    under two seconds having reviewed nothing. Expected, and the check stays red
    on purpose. Re-running or `re-review` does the same thing every time; the
    only way to get this PR reviewed is the trusted dispatch above.

  - **It never started.** It ended without naming a cause, after one turn or fewer
    and with nothing spent, so nothing in the PR was looked at. The Claude
    subscription behind `CLAUDE_CODE_OAUTH_TOKEN` hit its usage limit (clears on its
    own) or the token needs regenerating.
  - **It ran out of its turn budget.** It reviewed, then hit the cap.
  - **It hit an error.** The run ended with an error it named itself — a usage limit
    crossed mid-review, or a tool or MCP server that failed to start. The comment
    quotes what it said. Not a turn-budget problem, and not about your code.
  - **It finished but posted nothing.** The review reported success and no verdict
    reached the PR, so nothing here has actually been reviewed. (If it finished
    _and_ posted a verdict, the check is green — see above.)
  - **It could not tell.** The comment points you at the Actions log rather than
    guessing.

  In the middle two, whatever it already posted is worth reading, but the pass was
  cut short, so a re-review is owed. Read the comment before you go hunting in your
  diff. The wording comes from `scripts/classify-review-failure.sh`, and the shapes
  it must get right are pinned by `scripts/test-review-classifier.sh` (run by
  `pnpm verify` and by the `scripts-test` workflow) — DOR-457 was that comment
  confidently naming the wrong cause nine times, and then doing it again for a
  different shape that had no fixture, so add a fixture if you touch it.

- **A red `lint` check is often the formatting gate, not ESLint.** The
  required `lint` workflow runs `pnpm format:check` as its first step (moved
  there from `typecheck` in the DOR-627 follow-up, 2026-09-02), so a prettier
  miss reports under the lint name — the log's turbo section can print
  everything successful while the check is red from the step above it. Read
  the log before assuming lint errors. Two related traps: a local whole-repo
  `format:check` on a branch behind `main` reports files that are not yours
  (merge `origin/main` in before believing it), and a merge commit made with
  `LEFTHOOK=0` skips the format hook, so merge-combined files reach CI
  unformatted — after any hook-skipped commit, `pnpm exec prettier --write` the
  touched files.

- **The pre-push `--affected` gate pins its own base — do not pull to shrink it.**
  Until DOR-1717 the hook diffed against the _local_ `main` ref, so a shared
  checkout sitting behind origin exploded the affected set to the whole repo and
  hit unrelated flakes; the workaround was to `git pull --ff-only` in the clean
  main checkout before pushing (it bit three times in one session, 2026-08-25).
  The hook now sets `TURBO_SCM_BASE` to `origin/main` itself, so the local ref's
  position no longer affects anything and that ritual is obsolete — pulling in a
  checkout another agent is using is a worktree hazard for no gain. If the gate
  still selects more than your branch touched, the cause is a real dependency
  edge, `turbo.json`, or `pnpm-lock.yaml` (both global inputs), not staleness.

- **A schema or route change owes a regenerated OpenAPI export.** Anything
  touching `packages/shared` schemas that project into the API, or server routes,
  needs `pnpm docs:export-api` (and the site's `generate:api-docs`) in the same
  branch, or `openapi-fresh` goes red.

- **A stalled merge queue may be GitHub, not you.** Before debugging why
  merge-group runs sit "queued" for hours, check githubstatus.com. A 2026-08-26
  Actions outage held every queue entry for about 4 hours.

- **Changelog populator.** A `post-commit` hook writes a changelog fragment under
  `changelog/unreleased/` from the commit subject (it dedupes across amend/rebase and
  never touches `CHANGELOG.md`). For changes that should not land in the user-facing
  changelog, `touch .claude/.changelog-populator.lock` before committing (the lock is
  gitignored) and delete any fragment it already wrote.
- **A new Linear issue lands in Triage, not the backlog.** `issueCreate` without an
  explicit `stateId` leaves the issue in the team's triage queue, where it is easy to
  miss; two issues created on 2026-07-28 had to be moved by hand. Normally this is not
  yours to get right — all tracker I/O routes through the `/flow` `linear-adapter`
  skill (`AGENTS.md`), which sets state for you. Pass `stateId` yourself only as a
  stopgap, when you are calling the API directly because the adapter is unreachable.
- **The review is non-blocking, for now.** It posts comments and is not one of the
  required checks, so the queue does not wait on it. It still matters twice: a red
  review check makes merge-tail skip the PR (until the next push, since the check
  belongs to the old SHA), and a PR someone armed early merges with its findings
  open. Address findings before the PR is armed. CI Steward phase 2 plans a
  required, always-running review gate that goes red on an open Important finding.
