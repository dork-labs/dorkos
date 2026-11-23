---
id: 261123-215243
title: The cloud Security verdict counts as Security's sign-off, and the Claude review runs on every push
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.pr-gates.pr-gates
  - wf.claude-code-review.review
  - wf.security-verdict.security-verdict
prs: []
ratchet-release: []
field-changes: []
---

Dorian, Nov 23: "the fastest, smoothest, most streamlined PR process for now". The local Security
agent has not labelled a PR since #4159, because agents run in herdr, not DorkOS. So every PR
either merged with no Security sign-off (arm-door paused) or would wait forever (arm-door on).

- `pr-gates` now also accepts a `success` `security-verdict` status on the head as Security's
  sign-off. The status must be posted by GitHub Actions, which means main's `security-verdict.yml`
  reading the cloud lens's fixed-shape verdict. QA's and the designer's labels still count.
- `claude-code-review.yml` reviews on every push (`synchronize`), so every head gets a verdict.
- Next steps (ci-steward): once this lands, make `pr-gates` required. `open-pr.sh` then turns on
  auto-merge at open, and arm-door stays retired, because `pr-gates` runs on every queue entry.

Trade-offs, accepted:

- The comparison period against the local Security agent is skipped.
- Review cost rises to one review per push.
- A label stays the stronger signal: when Security is back, its label still passes the gate on its
  own.

Revert if the cloud lens passes something Security would have blocked, or if review cost or
turn-budget failures climb.
