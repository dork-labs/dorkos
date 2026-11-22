---
id: 261122-012943
title: A hold names a category, and a hold that names only a gate fails the hold-reason check
kind: experiment
status: proposed
actor: agent
gates:
  - wf.hold-reason.hold-reason
prs: []
hypothesis:
  metric: 'tracked.unjustified-hold-share'
  slo: 'lead-time'
  baseline: 0.42
  baseline_source: 'counted by CI Steward on 2026-11-21: 5 of 12 open PRs were held for a gate-only reason or none'
  target: 0
  after_days: 7
ratchet-release: []
floor-release: []
field-changes: []
---

CI Steward's count on Nov 22 (DOR-4974): 9 of 12 open PRs carried `hold`, and 4 of those reasons
named only a gate that `arm.sh`, the verify-proof check or the release pin already enforces
(Security, design, the release lead, verify). A hold like that only adds a person to wake.

A hold reason is now `<category>: <detail>`, with the category one of `migration-collision`,
`stacked`, `external-dependency` or `other`. `scripts/hold-reason-check.sh` fails a `hold:`
comment with no category, no detail, or a detail that is only gate words and filler, and its
`--reason` mode is what `scripts/open-pr.sh --hold` calls, so the two share one rule. A
`hold:` line in the PR body also counts, and `hold-reason.yml` now re-runs on `opened`,
`reopened` and `edited`, so fixing a reason means editing the body rather than toggling the label
(which re-fires merge-tail and the arm events). Old free-text reasons warn instead of failing until
2026-11-29, so the holds already open do not all turn red at once; that grace branch is deleted
in a follow-up once the date passes. The release procedure no longer
puts `hold` on queued PRs during a freeze: the freeze lock and the release pin already refuse those
arms. The check stays advisory. Fixtures: `scripts/test-hold-reason-check.sh` and
`scripts/test-open-pr.sh`.

The collector does not compute `tracked.unjustified-hold-share` yet; CI Steward reads it by hand
for its digest until it does. Revert if the word test refuses a real outside dependency often enough
that people stop using `hold` and park PRs instead.
