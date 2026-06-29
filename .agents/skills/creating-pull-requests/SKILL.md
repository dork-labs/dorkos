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

This mirrors how human teams work: pushes are work-in-progress, and the author
pulls the reviewer back in with an explicit "ready again" signal. It avoids
re-reviewing five or six times while you address feedback.

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

- **Workflow changes can't be tested on their own PR.** GitHub runs the review
  workflow as defined on the default branch, so changes to
  `.github/workflows/claude-code-review.yml` or `REVIEW.md` only take effect after
  merge. Merge to `main`, then exercise on a throwaway PR.
- **Changelog populator.** A `post-commit` hook re-adds `[Unreleased]` entries
  from the commit subject with no dedup. For changes that should not land in the
  user-facing changelog, `touch .claude/.changelog-populator.lock` before
  committing (the lock is gitignored).
- **The review is non-blocking.** It posts comments; it never gates merge. You can
  merge without waiting for it.
