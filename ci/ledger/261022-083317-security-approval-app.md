---
id: 261022-083317
title: Bind Security approval to a dedicated GitHub App
kind: hygiene
status: proposed
actor: agent
gates:
  [
    wf.security-gate.security-gate,
    wf.security-review-initialize.initialize,
    wf.security-approve-tests.acl,
  ]
prs: []
ratchet-release: []
field-changes: []
---

Require the newest sensitive-head security-review success to carry the numeric
bot user ID pinned in the workflow. A similar slug or later user success refuses.
Preserve complete nonsensitive automatic classification. Replace the Node/env-key
writer with compiled Swift and a separate exact-cdhash Keychain provisioner.
The approval binary accepts only PR/SHA, requests owner authentication, signs
RS256 in memory and writes only the exact current head. No real key/identity is
used by this lane. The App/bot IDs remain fail-closed zero placeholders.

Tests use a mock signer and disposable Keychain items. Reader pairs share
either one ad-hoc identity/designated requirement or one synthetic signing
certificate; both cases refuse the different binary. No trust settings change.
The exact-hash reader succeeds; a same-identity/identifier different binary and
a stripped copy cannot read. Positive controls bracket the denials. Exact ACL
construction uses an exported Apple SPI; absence refuses, never broadens trust.
Document that compatibility dependency and require Security review. No 1Password,
settings, rulesets, real signing or live approval. Hosted queue proof and real
provisioning remain pending. Revert on attribution/ACL/race defects without
falling back to shared-user statuses or broad certificate requirements.

Security M1 enforces hardened runtime and forbids debug/library-injection
entitlements in the provisioner before Keychain operations. Local verification
uses only canned codesign display strings. Real ACL/helper suites are guarded
CI-macOS-only after the operator-session prompt outage. Rebased on #3171 to
preserve the full path union and numeric creator check in computed/queue logic.
