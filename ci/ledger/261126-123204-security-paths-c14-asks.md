---
id: 261126-123204
title: Security's main path list names C14's asks port homes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C14 (DOR-5459) moves the consent cards and the writing of standing consent
decisions to the space side, behind an asks port. The space side's home,
`services/core/approvals/computer-asks/`, is already on the list. Joining it:
the port's contract and the helpers both sides use to word a card, bind its
yes and key the decision (`packages/shared/src/computer-asks.ts`,
`approval-text.ts`, `consent-entries.ts`, `folder-allows-card.ts`, moved out of
paths the list already held), and the slots the computer side asks through
with the startup step that fills them (`startup/computer-asks.ts`,
`services/runtimes/computer-asks.ts`, `services/harness/computer-asks.ts`).
Added in `security-gate.yml`'s `SECURITY_PATH_PATTERN`, its regex fixture and
`Policy.swift`, with a parity row each and a look-alike that stays off. Same
shape as 261126-092714 (C5).
