---
id: 261024-135500
title: Require Security review for dependency configuration and case-varied manifests
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate, wf.security-review-initialize.initialize]
prs: []
ratchet-release: []
field-changes: []
---

Extend the approved trust-path reference to .npmrc, patches/, .pnpmfile.cjs and
.nvmrc, at the root or inside a workspace. Match package.json's whole basename
without regard to case. Use ASCII letter classes rather than a global flag so
JavaScript and the coordinator's grep -E checker share one exact pattern and all
other paths keep their existing case semantics. Fixtures check matches,
near-misses, renames and both regex engines for every new alternative.

Stacked on the approved #3171 head while that PR drains. No parent push, rule,
permission, timeout, retry or required-context change. The coordinator updates
the host-only interim checker from the approved fixture after the head is
reported. Live host parity intentionally refuses the old checker until that
update; the CI-shaped checkout verifies the new workflow/reference and fixtures
without weakening the live assertion.

The 2026-10-23 CI snapshot reports unhealthy: org ruleset comparison is denied
with HTTP 403, and one clone's local timing export is stale. This hygiene change
claims no measured performance improvement and changes neither collector nor
credentials. Revert only for a demonstrated false classification; never clear a
missing file list. Multi-entry queue behavior remains unproven until live capture.
