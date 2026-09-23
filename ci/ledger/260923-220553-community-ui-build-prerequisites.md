---
id: 260923-220553
title: Build shared UI before Community browser and image checks
kind: incident-fix
status: active
actor: agent
gates:
  - wf.test.community-pg
  - wf.test.community-packaged
prs: [2046]
hypothesis:
  metric: 'gate.wf.test.community-pg.failure_rate@pull_request'
  slo: 'queue-green'
  baseline: 0
  baseline_source: 'CI Steward latest.json for 2026-09-22, snapshots/2026-09-22.json: community-pg pull_request had 18 successes and one cancelled run, zero failed completed runs. PR 2046 job 107400295730 subsequently exposed the missing shared UI build.'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

The shared UI extraction adds a built workspace dependency to Community. Its
Postgres/browser job builds dependencies explicitly and did not build that new
package, so Vite could not resolve its entry in a clean runner. The release image
and sealed acceptance image have the same explicit build boundary. Local tests
with an already-built UI package did not exercise that boundary.

Build UI alongside the existing prerequisite packages. Include its manifest and
source in the release image's allowlisted context. Preserve every browser and
Postgres assertion, retries, deadlines, required context and event condition.
The 2026-09-22 snapshot is healthy and names queue-green as the constraint (0.6308).
The target preserves the prior healthy job; the failing PR job is the direct
red-before-fix evidence, not a fabricated seven-day failure rate.

Verify clean image builds, the Community browser checks and the census/ledger
oracles. Revert or correct this change if the built package still cannot resolve
or if adding its prerequisite alters application behavior. No publication or
release pipeline is introduced.
