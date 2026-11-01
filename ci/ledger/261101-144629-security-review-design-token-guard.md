---
id: 261101-144629
title: The security gate counts the design-token guard
kind: hygiene
status: proposed
actor: agent
gates: [wf.security-gate.security-gate, wf.security-review-initialize.initialize]
prs: []
ratchet-release: []
field-changes: []
---

S2 from Security's review of #3375. The design-token guard
(`scripts/check-design-tokens.ts` and `scripts/design-tokens/`) runs from the
PR's own code, and the security path list did not cover it. A PR could edit the
guard to always pass and get the automatic "no security paths" status.

The pattern gains `scripts/check-design-tokens\.ts$` and `scripts/design-tokens/`
in all three tracked copies at once (the workflow, the approved reference
fixture, and `tools/security-approve/Policy.swift`); the parity test keeps them
equal, and Security updates the host-only interim checker to match. The guard's
own tests (`scripts/__tests__/check-design-tokens.test.ts`) stay ungated:
changing them alone cannot change what the guard decides. Fixtures pair each
match with a near-miss (`scripts/check-design-tokens.test.ts`,
`scripts/design-tokensx/`) and a rename.

Metric (not in `ci/metrics.yaml`, so stated here; hygiene is exempt): PRs that
touch the design-token guard and get the automatic "no security paths" status.
Baseline 0 (the guard is not on `main` yet; #3375 adds it). Target 0. Check on
2026-11-15 by listing merged PRs that touch these paths and reading their
`security-review` status.

No required check, permission, timeout or ruleset change. Cost: every PR that
edits the guard waits for Security. Revert only for a shown false
classification, never to clear a pending review.
