---
id: 261126-092714
title: Security's main path list names C5's visibility homes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C5 (DOR-5457) moves the rules for who sees what, or the way they are reached.
At Security's request, three of their homes join the main list:
`services/core/browser-registry/` (whose browser an agent may use),
`services/session/catalog/session-list-space-view.ts` and
`services/session/chat-rows/` (who sees which chats). Added in
`security-gate.yml`'s `SECURITY_PATH_PATTERN`, its regex fixture and
`Policy.swift`, with a parity row each and a look-alike that stays off. Same
shape as 261126-072144 (C4).
