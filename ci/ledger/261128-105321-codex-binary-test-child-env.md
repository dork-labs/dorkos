---
id: 261128-105321
title: 'The Codex binary test spies on childEnvironment, the one env helper (DOR-5481)'
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Hygiene, no measurable change. DOR-5481 renamed the runtime env helper to childEnvironment(kind); the Codex app-server binary test's two spies follow the rename. The test still pins the same env reaching the Codex binary. Revert only if the rename is reverted.
