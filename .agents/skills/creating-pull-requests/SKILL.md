---
name: creating-pull-requests
description: When to open a pull request in the DorkOS repo (review the pushed branch first, open the PR after it converges) and how the automated review behaves, including its controls (skip-review, review:light/deep, re-review). Use when finishing a branch, opening a PR, deciding how much review a PR should get, or requesting a re-review after addressing feedback.
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
  it. One night of that took roughly a dozen `gh pr update-branch` calls and still
  left a `DIRTY` PR needing a semantic conflict resolved by hand.
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

| Event                         | Review?                                 |
| ----------------------------- | --------------------------------------- |
| PR opened (non-draft)         | One full review                         |
| Draft marked ready-for-review | One full review of the final state      |
| New commits pushed            | **No** auto-review (CI tests still run) |
| `re-review` label applied     | One re-review, scoped to the delta      |
| PR has merge conflicts        | **Nothing runs at all** — see below     |
| PR edits a Claude workflow    | **Green check, no review** — see below  |

This mirrors how human teams work: pushes are work-in-progress, and the author
pulls the reviewer back in with an explicit "ready again" signal. It avoids
re-reviewing five or six times while you address feedback.

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
the PR is carrying it. Two differences from an automatic run, because the Claude
action treats a manual trigger as having no PR identity:

- It posts its line-level findings through the GitHub API instead of the action's
  inline-comment tool. Same result, slightly more turns spent.
- It reverts `.claude/`, `.mcp.json`, `CLAUDE.md` and `.husky` in the checkout to
  the `main` versions before reviewing, so a PR can never make its own reviewer run
  hooks the PR wrote. The reviewer still reads those changes from the diff. (An
  automatic run gets the same protection from the action itself.)

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

## Merging: arm auto-merge instead of babysitting it

Where the base branch requires status checks _and_ requires branches to be up to
date, merging by hand becomes a loop: update the branch, wait a few minutes for
checks, try to merge, find that the base moved again, start over. Hand the loop to
GitHub instead:

```bash
gh pr merge --auto --squash <number>
```

The PR then merges itself once its required checks pass **and its branch is up to
date with the base**. (The repo must have auto-merge turned on; DorkOS does.)

**Arm it after a review pass, not before.** Nothing here requires an approving
review, so an armed auto-merge lands the PR on its required checks alone. The order
is the whole safeguard: review, then arm.

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

### An armed PR that is BEHIND stalls forever, silently

This is the third silent stall in this file, and the one that actually backs up the
repo. **GitHub's auto-merge never updates a pull request branch.** It waits for
every merge requirement to be satisfied; under "require branches to be up to date"
(`required_status_checks.strict`), "branch is not behind the base" is one of those
requirements, and auto-merge will not satisfy it for you. So a PR that is green,
armed, and `BEHIND` waits for a condition nothing in the system will ever produce.

It looks exactly like a PR that is about to merge. It never does.

On 2026-07-28 this had six PRs stuck at once, the oldest green and armed for nine
hours and seventeen commits behind, while sixty commits landed on `main` around
them. At this repo's merge rate every armed PR reaches this state within the hour.

Check for it by state, not by the checkmarks:

```bash
gh pr view <number> --json mergeStateStatus --jq .mergeStateStatus   # BEHIND == stalled
gh pr update-branch <number>                                        # the only way out
```

**Update one branch at a time, oldest first.** Every merge to `main` puts every
other open PR back to `BEHIND`, so updating all of them at once starts a CI stampede
that re-loses the race for all of them. Serializing turns a lottery into a queue.

**Who arms it.** In the autonomous loop this is the flow plugin's job (ADR-0276's
auto-merge recovery ladder). That loop is `enabled: false` in v1, so **outside it
nobody arms auto-merge unless you do**. Opening a PR and stopping at the review gate
leaves it parked indefinitely; landing it is a separate, explicit step.

**Only people with write access can arm it.** In GitHub's words: "People with write
permissions to a repository can enable auto-merge for a pull request." An outside
contributor on a fork PR cannot arm their own merge.

**Ask the repo what its required checks are; never assume.** The set differs per
repo and changes over time, so any list written down here would go stale:

```bash
gh api repos/{owner}/{repo}/branches/main/protection --jq '.required_status_checks'
```

**Never require a check whose workflow has a `paths:` filter.** That workflow does
not run on a PR that touches nothing under those paths, and GitHub leaves the check
pending rather than skipping it: "If a workflow is skipped due to path filtering,
branch filtering or a commit message, then checks associated with that workflow
will remain in a 'Pending' state. A pull request that requires those checks to be
successful will be blocked from merging." An auto-merge armed on such a PR waits
forever too. (DorkOS's `main` today requires `typecheck`, `fragment-present`,
`no-fragment-under-skip-label`, and `version-outranks-base`, none from a workflow
with a `paths:` filter. Run the command above rather than trusting this list.)

### Watching an armed PR: watch the checks, not the merge state

The fourth silent stall, and the easiest to inflict on yourself. Once a PR is armed
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
needs. Confirm the required set (`…/branches/main/protection`, above), then act only
on a **required** check that went red on **this** PR.

Watch with a loop that ends on every terminal outcome — a non-`Vercel` check
failing, or the PR merging — not one that only knows how to notice success (the
`Monitor` tool is the ergonomic form of this; the shape is what matters):

```bash
# emits on the first real failure, the merge, or its own expiry; silent while healthy
for i in $(seq 1 55); do
  state=$(gh pr view <number> --json state --jq .state)
  [ "$state" = MERGED ] && { echo MERGED; exit 0; }
  [ "$state" = CLOSED ] && { echo "CLOSED unmerged"; exit 0; }
  fails=$(gh pr checks <number> | awk -F'\t' '$2=="fail"{print $1}' | grep -vi '^Vercel')
  [ -n "$fails" ] && { echo "FAILED: $fails"; exit 0; }
  sleep 45
done
echo "watcher expired; PR <number> still unmerged — check it directly"
```

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
- **A watcher that dies must say so.** The loop above echoes its own expiry
  (~41 minutes); keep that shape, and answer it — an armed PR that outlives its
  watcher deserves a direct `gh pr checks` look, whatever the watcher reported.

Note the shape of the four traps together: a **conflicting** PR runs nothing, a PR
missing a **path-filtered** required check hangs pending, a **BEHIND** PR is green
and armed and still cannot merge, and a **failed-check** PR reads exactly like a
slow one. All four look like a PR that is fine.

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

- **Any PR that edits a Claude workflow file gets a green check and no review.**
  The Claude action refuses to start unless the workflow file it is running from
  matches the copy on `main` — otherwise a PR could rewrite the workflow to steal
  the token — and it exits _successfully_. So a PR touching
  `.github/workflows/claude-code-review.yml` gets a green `claude-code-review`
  check with nothing reviewed, and a PR touching `.github/workflows/claude.yml`
  gets the same silence from `@claude` mentions on that PR. It is per file: editing
  one does not disable the other. The steps around the action still run, so YAML
  and shell mistakes do surface; the review itself does not. Merge first, then
  exercise the merged version against a real PR with
  `gh workflow run claude-code-review.yml -f pr=<number>`.
- **A red review check is not always a finding.** When the review itself breaks, it
  posts a comment saying so and naming which of five things happened:
  - **It never started.** It ended without naming a cause, after one turn or fewer
    and with nothing spent, so nothing in the PR was looked at. The Claude
    subscription behind `CLAUDE_CODE_OAUTH_TOKEN` hit its usage limit (clears on its
    own) or the token needs regenerating.
  - **It ran out of its turn budget.** It reviewed, then hit the cap.
  - **It hit an error.** The run ended with an error it named itself — a usage limit
    crossed mid-review, or a tool or MCP server that failed to start. The comment
    quotes what it said. Not a turn-budget problem, and not about your code.
  - **The review finished but the check is still red.** The review reported success,
    so the failure is in the machinery around it (posting, cleanup, the runner). Any
    verdict above is complete.
  - **It could not tell.** The comment points you at the Actions log rather than
    guessing.

  In the middle three, any verdict already posted stands. Read the comment before you
  go hunting in your diff. The wording comes from
  `scripts/classify-review-failure.sh`, and the shapes it must get right are pinned
  by `scripts/test-review-classifier.sh` (run by `pnpm verify` and by the
  `scripts-test` workflow) — DOR-457 was that comment confidently naming the wrong
  cause nine times, and then doing it again for a different shape that had no
  fixture, so add a fixture if you touch it.

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
- **The review is non-blocking.** It posts comments, and it is not one of the
  branch's required checks, so nothing waits on it. That is not the same as being
  free to merge: branch protection still gates the merge on the checks it does
  require. Arming auto-merge is how you stop waiting on the review without
  pretending the other gates are gone.
