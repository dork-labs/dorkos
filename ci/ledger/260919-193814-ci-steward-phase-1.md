---
id: 260919-193814
title: 'CI Steward phase 1: daily collector, verdicts, weekly report, data branch, local hook timings'
kind: hygiene
status: active
actor: agent
gates:
  - wf.ci-steward.collect
  - wf.test.test-shard
  - lefthook.pre-commit.format
  - lefthook.pre-commit.db-migrations
  - lefthook.pre-commit.dir-size
  - lefthook.pre-commit.lint
  - lefthook.pre-commit.typecheck
  - lefthook.pre-push.formatting
prs: []
ratchet-release: []
field-changes: []
---

<!-- Amended 2026-09-20 (DOR-2160): `lefthook.pre-push.tests` removed from `gates:` because the command no longer exists (ci/ledger/260919-175505-*). Nothing about phase 1 changed; the time-wrap still opens every command this file lists. -->

Phase 1 ("Observe") of plans/ci-steward-plan.md (DOR-2149). Hygiene, because it measures the
pipeline rather than changing what any gate checks. Its own cost is the check: the plan's §8 says
under 15 runner-minutes a day for the collector and zero queue builds, and the weekly report shows
both.

**What runs now:**

- `.github/workflows/ci-steward.yml`, a new job that is never required: daily at 05:00 UTC it runs
  `ci-steward daily` (collect, verdicts, and on Mondays the report and floors) and pushes to the
  orphan `ci-steward-data` branch, tagging `ci-steward-data/YYYY-Www` whenever that week's tag is
  missing. It creates the branch only when neither the branch nor a backup tag exists, and
  refuses otherwise. The checkout keeps no credentials; only the publish step gets the token.
- Every lefthook command opens with one sourced line, the POSIX time-wrap, which appends START and
  END to the clone's local-timings.jsonl, behind a `[ -r ]` guard. The command bodies are byte for
  byte what they were; the wrapper adds a `git rev-parse`, two `date`s and two appends per command
  (a few milliseconds). One behaviour changes on purpose: INT, TERM and HUP are trapped, so a
  signalled hook writes END 128+n and exits 128+n (bash as `/bin/sh` used to exit 0 on SIGTERM).
- `test-shard` uploads its vitest shard and flake reports as `vitest-shard-report-N` on the queue
  leg, with `continue-on-error` (allowlisted) and `!cancelled()` so red shards upload too, so the
  collector can sample flaky-test-runs. Its cost is one small upload per shard: a few seconds of
  each queue shard's duration, about 1% of the ~12-minute shard. The
  fan-in does not download them yet: nothing reads them there until phase 2's ratchet, and a
  download with no reader would only add a way for the required `test` job to fail.

**The PR author's side:** merge-tail's `*/10` cron was measured running about 7 times a day
(median gap 162 minutes over 200 runs, 2026-08-25 to 09-19), so `watch-prs.sh`, its fixtures,
the `creating-pull-requests` skill, AGENTS.md, `contributing/ci.md` and merge-tail's own comment
stop promising a 10-minute arm: agents arm their own green PRs with `gh pr merge --auto`, and
re-arm after a failed-checks ejection once the failing job's log shows it was not theirs.
Proposal 260919-204500 makes merge-tail event-driven.

**Deferred:** follow-up H (the PR advisory for gate minutes) moves to phase 2 with the other PR
advisories, because it reports on the same comment surface as the ratchet advisory.

Revert the workflow if it ever writes anywhere but `ci-steward-data`; revert the time-wrap line if
any hook's exit status, stdin or output differs with it (the package's shell tests pin all three
under dash, bash and ksh).
