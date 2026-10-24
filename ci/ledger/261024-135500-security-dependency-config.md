---
id: 261024-135500
title: Require Security review for dependency configuration and case-varied manifests
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate, wf.security-review-initialize.initialize]
prs: [3191]
ratchet-release: []
field-changes: []
---

Extend the approved trust-path reference to .npmrc, patches/, .pnpmfile.cjs and
.nvmrc, at the root or inside a workspace. Match both the original path and its
NFKC-normalized lowercase form, including both sides of a rename. This closes
case-variant and compatibility-character bypasses across all security paths.
Keep one exact regex shared by JavaScript and the coordinator's grep -E checker;
fixtures check matches, near-misses, renames and the normalized POSIX ERE input.

The follow-up to #3171 is held as #3191. No parent push, permission, timeout,
retry or required-context change. The host-only interim checker already folds
paths; its regex still requires the dependency-path alternatives from the
approved fixture. Live host parity refuses until that coordinator-owned update;
the CI-shaped checkout verifies the new workflow/reference and fixtures without
weakening the live assertion.

The 2026-10-23 CI snapshot reports unhealthy: org ruleset comparison is denied
with HTTP 403, and one clone's local timing export is stale. This hygiene change
claims no measured performance improvement and changes neither collector nor
credentials. Revert only for a demonstrated false classification; never clear a
missing file list. Multi-entry queue behavior remains unproven until live capture.
