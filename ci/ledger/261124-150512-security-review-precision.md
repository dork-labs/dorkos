---
id: 261124-150512
title: The review workflow decides push mode from the reviewer's own comments; findings decrypt shows every block for the head
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.claude-code-review.review
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

Agreed by Security and ci-steward, Nov 24. Two precision changes to the cloud Security lens
plumbing.

1. Push mode is decided by code. Since ledger 261124-115930 (review-spend) a push to an
   already-reviewed PR runs the Security lens only, and the reviewer decided that itself by reading
   the PR's comments. Now a workflow step, "Decide the review mode", runs main's copy of
   `scripts/review-mode.sh` before the review and passes `REVIEW MODE: push-recheck` or
   `REVIEW MODE: full` into the prompt. Push re-check needs a `synchronize` trigger and at least one
   top-level comment by `claude[bot]` (user type Bot) carrying a full review's tally, in the same
   shapes the verdict probe accepts (a fixture keeps the two regexes equal). A push re-check's own
   summary and the Security verdict do not count, so a PR whose only summaries are push re-checks
   gets a full review. Every doubt (not a push, the script not yet on main, unreadable comments,
   any other answer) is `full`.
2. `scripts/security-findings.sh decrypt <pr> <identity>` shows every block posted for the current
   head, oldest first, each after a header on stderr (posted-at, short head, "block i of n"),
   because each review of a head posts its own block. With none for the current head it falls back
   to the newest block at all, flagged as not the current head. A block the identity cannot open
   is reported and skipped; exit 1 only if none opened.

Baseline: push mode decided by the model on 100% of push runs; `decrypt` shows 1 block per head.
Target: push mode decided by `review-mode.sh` on 100% of push runs (the job summary's
"review mode" line); no push re-check on a PR without a full `claude[bot]` summary; `decrypt`
shows every current-head block.
Evaluate: Dec 8. Sample ten push runs after merge: each has a "review mode" line, and each
`push-recheck` PR has an earlier full summary by `claude[bot]`.

Revert (1) if push re-checks stop happening on PRs that had a full review (the step always says
`full`), which would put review spend back above the review-spend ledger's level. Revert (2) if
Security finds the multi-block output harder to use than the single newest block.
