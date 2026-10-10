---
id: 261009-174640
title: Scan docs prose for the "chat, not session" vocabulary wave
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [2693]
ratchet-release: []
field-changes: []
---

DOR-2789 retires "session" and "conversation" in everything people read and adds wave-7 to `scripts/vocab-gate/banned-terms.json`. The one change to `scripts/check-vocab-gate.ts` adds wave-7 to `MDX_SCANNED_WAVES`, so the docs scan enforces it the same way it already enforces the earlier waves; two pin tests in `check-vocab-gate.test.ts` cover it. No gate, required check, retry or timeout changes, and the gate already runs inside `typecheck`. Revert if the docs scan's runtime grows noticeably or the wave fires on legitimate technical prose the allowlist cannot scope.
