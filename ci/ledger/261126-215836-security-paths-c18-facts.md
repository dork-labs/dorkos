---
id: 261126-215836
title: Security's main path list names C18's agent facts port homes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C18 (DOR-5462) puts what the computer side knows about an agent behind an
agent facts port: whose home a folder is, where git may run, where an agent
may work, which agent a chat is, and the DorkOS CLI token a launch hands the
agent. The space side's half, `services/core/agent-identity/facts/`, is
already on the list. Joining it: the port's contract
(`packages/shared/src/agent-facts.ts`, which also holds the pure home helpers
moved out of `core/agent-identity/agent-home.ts`), the startup step that fills
the slots and points the home resolver at the live registry
(`startup/agent-facts.ts`), and the slots the computer side reads through in
folders the list does not hold (`services/runtimes/`, `services/harness/`,
`services/session/turn-port/` and `services/diff/` `agent-facts.ts`; the
`workspace/` and `browser/` slots are inside folders the list holds, and the
slot for the files directly in `services/core/` lives in `git-status.ts`,
which is not on the list). Also `services/harness/marketplace-repo-key.ts`, moved out of
`services/marketplace/`, which the list holds. Added in `security-gate.yml`'s
`SECURITY_PATH_PATTERN`, its regex fixture and `Policy.swift`, with a parity
row each and a look-alike that stays off. Same shape as 261126-123204 (C14).
