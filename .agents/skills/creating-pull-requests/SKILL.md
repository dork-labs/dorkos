---
name: creating-pull-requests
description: How to open pull requests in the DorkOS repo, including the automated-review controls (skip-review, review:light/deep, re-review). Use when opening a PR, deciding how much review a PR should get, or requesting a re-review after addressing feedback.
---

# Creating Pull Requests

How DorkOS PRs are opened and how the automated Claude review behaves on them.
This repo is routinely multi-agent, so the mechanics below keep PRs clean and the
review loop cheap.

## When to use

- You are about to open a PR (from an agent or by hand).
- A PR already has review feedback and you want another pass once it is addressed.
- You want to dial a PR's review up, down, or off.

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

## Opening the PR

Iterate as a **draft**, then mark ready when the branch is done:

```bash
gh pr create --draft --title "<type>(<scope>): <summary>" --body "<body>"
# ... push commits, iterate freely (no review runs while draft) ...
gh pr ready <number>        # marking ready fires exactly one full review
```

Why draft-first: the auto-review is **on-demand**, not on every push (see below).
A draft gets no review, so you can push freely; marking ready triggers one review
of the final state. PR body: lead with what changed and why, link the spec or
issue, and call out anything reviewers should look at first.

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
- **The review is non-blocking.** It posts comments; it never gates merge. You can
  merge without waiting for it.
