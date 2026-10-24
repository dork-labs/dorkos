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
fully folded and NFKC-then-folded forms, including both sides of a rename.
Preserve the original flagless match first, then add Unicode case-insensitive
matching for every supplied pattern, including repo-configured patterns. This closes case-variant and compatibility-character
bypasses across all security paths while retaining every original-path match.
Keep one exact regex shared by JavaScript and the coordinator's grep -E checker;
fixtures check matches, near-misses, renames and the normalized POSIX ERE input.
The shared spelling fixture is copied byte-for-byte from marketplace #121, blob
32a042ddddc493f52f51883832b031c05f92a430. Configured-pattern fixtures also cover
mixed case, sharp-s expansion, original spellings, regex escapes, negative
lookaheads and negated classes. The final shared fixture comes from marketplace
head 2210bfa637803245200ea3a799e12053b63123a2.
Nested workspace patches remain sensitive at any depth. A scoped Prettier ignore
preserves the shared fixture bytes, enforced by its pinned Git-blob test.

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
