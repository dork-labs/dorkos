---
id: 261022-084338
title: Cover approval and remote trust paths in the security preflight
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate, wf.security-review-initialize.initialize]
prs: []
ratchet-release: []
field-changes: []
---

Security and QA widened the trust boundary after #3167 exposed missing remote
and process paths. Copy the coordinator's full regex exactly from the interim
checker; do not edit that checker. The workflow is the sole list. Export its
reader from the gate script and use it in the repo's read-only PR preflight.
A security-reviewed label still requires the exact SHA to be confirmed.

Fixtures cover a match and near-miss per new entry, renamed files, truncated
API data and moved heads. The real #3167 index/process/pinned-origin paths match.
No rule/settings changes and no arm/merge. Revert only for a demonstrated false
classification; never convert missing evidence to clearance.

Add desktop preload to the same pattern. For pre-initializer PRs, permit
read-only computed clearance only when the exact head has no security-review
status and the complete diff is nonsensitive; never override a refusal. PR files
are counted and capped at 3,000. Queue comparisons pin each entry’s immutable base and synthetic queued
head rather than borrowing current PR files, and refuse the 300-file compare
cap. Retain head/base/queue race checks and both rename paths. Fixtures include
a security-changing queued head followed by a client-only later PR head, API
errors, truncated/capped lists and explicit pending/failure statuses. No new
writer or permission is introduced. Hosted merge-group proof remains pending.

Security review M1 adds the exact permission/runtime, spaces/identity/computers,
room/session and shared permission alternatives from its read-only reference.
Each alternative has a positive and near-miss fixture. S1 rejects queue compares
whose merge base is absent or differs from the queue entry base.
