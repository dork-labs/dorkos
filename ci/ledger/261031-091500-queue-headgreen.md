---
id: 261031-091500
title: The merge queue merges a group on its last entry's build (HEADGREEN), to stop flake ejections
kind: experiment
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: wasted-queue-builds
  baseline: 0.0667
  baseline_source: 'ci-steward-data latest.json (collected 2026-10-30T11:16Z), SLO wasted-queue-builds, window 2026-10-23 to 2026-10-29, n=135 queue builds'
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes: []
---

Proposal: `ci/proposals/2026-10-31-queue-batching.md`. One ruleset field, `grouping_strategy` from `ALLGREEN` to `HEADGREEN` in ruleset 19893973. **Not applied.** A person applies it after Security's OK; set this entry to `active` with the date when that happens, since the window starts then.

Every entry still gets its own queue build under either strategy, so this saves no builds. What it changes: a group merges when its last entry's build passes. That build's tree contains every earlier entry, so an earlier entry whose own build flaked no longer gets ejected. `wasted-queue-builds` counts exactly those ejections (failed checks, then merged with no new commit).

Watch beside it: `main-green`. Squash merges leave one commit per PR on `main`; under HEADGREEN a middle one may have had only a red build of its own.

Revert (set `grouping_strategy` back to `ALLGREEN`, same commands, status `reverted`) if a red episode on `main` traces to a PR that merged on a later entry's build, if entries ahead of a red last entry get ejected with it, or if `wasted-queue-builds` is not below 0.05 after 14 days.

The minimum group size (3) is deliberately not changed here: a second change to the queue in the same window would confound this verdict.
