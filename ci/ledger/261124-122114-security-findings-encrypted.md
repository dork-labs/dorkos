---
id: 261124-122114
title: A failing cloud Security lens sends its details to Security, encrypted to Security's key
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.claude-code-review.review
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

Approved by Dorian, Nov 24. The cloud Security lens may not describe a Must in public (the repo is
public), so a `fail` verdict gave the author only a count and categories, and nobody got the
details: a dead end. Now the reviewer saves the details through `review-gh.sh security-findings`
(a `fail` is refused until it has), and a trusted step in the review job encrypts them with age to
the public key(s) in main's `ci/security/findings-recipients.txt`, deletes the plaintext and posts
only the ciphertext block (`pr=` and `head=` in the clear, nothing else). Security reads it with
`scripts/security-findings.sh list` and `decrypt <pr> <identity>`. No new credential in CI: only a
public key. Until Security adds its key the step discards the details and posts nothing.

The verdict check (`security-verdict-check.sh`) still reads only the verdict marker; a fixture
pins that a findings block changes nothing.

Baseline: 0 of the cloud lens's failing verdicts reach Security with their details.
Target: every failing verdict after Security's key lands has a findings block that Security can
decrypt, and no plaintext detail in any comment, log or artifact.
Evaluate: Dec 8 (two weeks after Security adds its key; if the key is not in by then, re-date).

Revert if a plaintext detail is found anywhere public, or if the send step ever makes the review
check red.
