---
id: 261125-025648
title: A config schema change brings its migration, or a written reason it needs none
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
hypothesis:
  metric: gate.wf.typecheck.typecheck.duration_p50@pull_request
  baseline: 8.83
  baseline_source: 'origin/ci-steward-data at cefa99f15f181f820d4c5e6c2e155a51797f096e, snapshots/2026-11-17..2026-11-23.json, gates["wf.typecheck.typecheck@pull_request"].durations: 604 completed runs, median 530 s = 8.83 min (p90 10.37 min); latest.json carries no per-gate durations'
  target: 8.93
  after_days: 7
ratchet-release: []
field-changes: []
---

The manual release had a person check that a config schema change came with the `conf`
migration it needs (`/system:release` Check 6). The daily release (DOR-5123) has no person,
and a missing migration fails silently: an upgraded install keeps a config the new code does
not describe.

This adds `Config migration gate (DOR-5123)` to the required `typecheck` job, beside the
file-size ratchet, with its base chosen the same way. `scripts/config-migration/check-config-migration.ts`
reduces `UserConfigSchema` to a flat shape (path to accepted values), held in
`scripts/config-migration/shape.json`, which must match the live schema. Against the base's
copy it fails a new member inside an existing section, a removal (so a rename) or a narrowed
type, unless the PR changes `CONFIG_MIGRATIONS` or adds a reason to
`scripts/config-migration/no-migration.json`. A new top-level section, a new optional member
with no default, a widened type and a comment-only edit pass. No new required check.

The metric is the whole job's p50 because CI Steward measures jobs, not steps. The step
takes about 0.5 s locally (measured 2026-11-24), well under the job's run-to-run noise.

Hypothesis: one schema import and two small JSON reads add no measurable time to the
required job. The target allows 0.1 minute of noise over the baseline median. The quality
claim (no schema change merges without its migration or a written reason) is enforced by
the step on every run and is not scored here.

Revert, or move the step, if the job's median grows past the target, or if the step reds a
PR for a reason its own message does not name.
