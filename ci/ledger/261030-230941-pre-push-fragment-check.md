---
id: 261030-230941
title: A push refuses an unedited seeded fragment, and the commit hook stops seeding beside a real one
kind: experiment
status: proposed
actor: agent
gates:
  - wf.changelog-fragment-check.fragment-present
prs: []
hypothesis:
  metric: 'gate.wf.changelog-fragment-check.fragment-present.failure_rate@pull_request'
  baseline: 0.063
  baseline_source: 'measured 2026-10-30T23:09Z with `gh run list --workflow changelog-fragment-check.yml --event pull_request -L 300` (2026-10-30T02:34Z to 23:08Z): 300 runs, 19 failed. How many of the 19 were seeds was not counted from logs; the PM named five PRs that went red on one (#3290, #3294, #3295, #3297, #3205) in the week to 10-30'
  target: 0.04
  after_days: 14
ratchet-release: []
field-changes: []
---

The post-commit hook (`.claude/git-hooks/changelog-populator.py`) seeds a fragment from every
`feat(`/`fix(`/`refactor(`/`perf(` commit, marked `dorkos-changelog:seeded`. The required
`fragment-present` check refuses that marker until someone rewrites the bullet. Nothing local said so,
so a lane found out from CI: a push, a red, a fix commit and a second full PR run on a queue already
short of runners.

Two changes, and neither touches `fragment-present`:

1. **The hook stops seeding beside a real fragment.** When the branch already carries a hand-written
   fragment (added or edited since it forked from origin/main, no seed marker, block-form `covers:`),
   the new commit's subject is appended to that fragment's `covers:` list instead. That is the most
   common shape of the reds: a second `fix(` commit on a branch whose author already wrote the entry.
   Coverage stays exact, by declaration.
2. **`pre-push` refuses an unedited seed.** `scripts/pre-push-fragment-check.sh` runs the same command
   as the check's validity step (`changelog_backfill.py --validate --changed-only` from the merge
   base), so it cannot disagree with it, and a stray fragment someone else wrote never refuses a push.
   It names the file and says to rewrite or delete it. About 0.1 s, pure-stdlib Python; with no
   `python3` it skips with a note.

Target: 0.063 to about 0.04, the share the seeds are estimated to cause. Rough, because the 19 failures
were not classified from logs. Counter-metric: pre-push time (`hook.pre-push.*` in the local timings)
must stay under 1 s p90 for the new command. Revert the push half if it refuses a push CI would pass;
revert the hook half if a fragment's `covers:` is ever edited into an invalid file.
