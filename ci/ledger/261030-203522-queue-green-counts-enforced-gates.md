---
id: 261030-203522
title: queue-green counts only the checks GitHub enforces
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: queue-green
  slo: queue-green
  baseline: 0.2
  baseline_source: ci-steward-data latest.json for 2026-10-23..2026-10-29 (n=135); recounted from the merge_group runs of that week
  target: 0.55
  after_days: 7
ratchet-release: []
field-changes: []
---

queue-green read 20% for 2026-10-23..29 (27 of 135 builds). 81 of the 108 red
builds were red on `security-gate.yml`, and 54 of them on nothing else. That
workflow is listed as a required workflow source, but its organization rule is
not active (the reviewed proposal is `disabled`; `rules/branches/main` shows no
workflows rule), so it blocked none of them: PR #3235's red build is the exact
commit that merged. Over the checks GitHub does enforce the same week was 80 of
134, 60%.

Each workflow source now carries `enforcement`, and the collector counts a source
toward queue-green and pr-feedback only when it is `active`. The live census still
requires `active`, so the unpromoted gate stays a visible finding; promotion
flips the field in the same change as the rule.

Stored days keep their old outcomes, so the after-window shows the change. Revert
if an `active` source is ever left out of the count, or if a source is marked
`active` while GitHub does not enforce it.
