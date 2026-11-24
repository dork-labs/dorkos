---
id: 261124-122630
title: pr-gates takes Security's sign-off as a signed review marker, checked against main's key, or the cloud verdict
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.pr-gates.pr-gates
prs: []
ratchet-release: []
field-changes: []
---

Security's sign-off becomes a signature. `scripts/pr-gates-check.sh` now counts Security's sign-off
only as a PR comment carrying Security's review marker for this repo, PR number and current head,
whose SSH signature (namespace `dorkos-security-review`, principal `security@dorkos`) verifies
against main's `ci/security/allowed_signers`, or as the cloud lens's passing `security-verdict`
status, unchanged. The `security-reviewed` label is printed as a note and no longer counts on its
own. `pr-gates.yml` reads the signers file from its checkout of main (the queue's base on a merge
group), never the PR's. QA and design notes are unchanged.

Until Security's public key lands in `ci/security/allowed_signers`, only the cloud verdict can pass
`pr-gates`.

Hygiene, not an experiment. Baseline: `pr-gates` passes that rest on a label alone are possible.
Target: zero; every `pr-gates` pass names a verified signed review or the cloud verdict in its log.
Evaluate 2026-12-08 by sampling that fortnight's passing `pr-gates` logs. Revert (to the cloud
verdict alone, never back to the label) if a correctly signed marker for the head fails to verify
on a real PR.
