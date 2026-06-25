---
name: flow-drain
display-name: /flow — drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
cron: '0 * * * *'
timezone: America/Los_Angeles
enabled: false
max-runtime: 2h
permissions: acceptEdits
---

Run one tick of the /flow autonomous loop:

1. Via adapters/linear, fetch eligible work and rank it (dispatch ladder, §4).
2. Claim the top issue (durable label + state), provision its worktree.
3. Carry it through the stages to its gate — uncertainty-gated involvement (§5).
4. Stop at the human-review gate or on a genuine question (needs-input).
