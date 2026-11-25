---
id: 261125-005730
title: The Security verdict marker is read only from claude[bot]; the review helper refuses reserved markers in bodies
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

Agreed by Security and ci-steward, Nov 24. A follow-up to 261124-150512 (security-review-precision).

1. `scripts/security-verdict-check.sh` reads the `<!-- dorkos-security-verdict v1 ... -->` marker
   only from comments with login `claude[bot]` and user type Bot. A marker from any other author,
   other bots included, is not read. The reviewer posts its verdict through
   `scripts/review-gh.sh security-verdict` as `claude[bot]`, so its verdicts are read as before.
2. `scripts/review-gh.sh summary` and `inline` refuse (exit 2, one-line message) a body that
   contains `<!-- dorkos-security-verdict` or `<!-- dorkos-review-summary`, in any case and with any
   whitespace after `<!--`. The helper's own marker line is appended to a summary after that check.

Fixtures: `scripts/test-security-verdict-check.sh` (markers by github-actions[bot], another bot,
`claude` without `[bot]` and a User named `claude[bot]` are not read; claude[bot]'s is) and
`scripts/test-review-classifier.sh` (six marker spellings refused by both subcommands; a body naming
the markers without `<!--` is posted with the helper's marker appended). Nothing measurable should
move: the security-verdict check's results on reviewed PRs stay the same. Revert (1) if a verdict the
reviewer posted is not read (the check fails with "has not judged this head" after a posted verdict);
revert (2) if a review's summary or inline comment is refused without carrying a marker.
