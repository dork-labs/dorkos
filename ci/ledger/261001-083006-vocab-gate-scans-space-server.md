---
id: 261001-083006
title: check-vocab-gate.ts scans the space server's copy (apps/community/src)
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2653 swept the space's own website (`apps/community`) from "community" to
"space", finishing what DOR-2631 started in the app. With that copy clean, the
gate now reads `apps/community/src` too, so the rename cannot quietly come back
on the space's pages, emails or API errors. All waves apply there, so the same
change fixed its few typography escapes and one "provider", and allowlists the
pairing page's "connection" (an approved DorkOS install, not network health).

Two code changes: `apps/community/src` joins `DEFAULT_SCAN_ROOTS`, and
colocated `*.test.ts(x)` files are skipped the way `__tests__/` already was
(the module doc always said they were; `apps/community` is the first scanned
tree that keeps tests beside the source). No timing, retry, shard or
required-status change: one more workspace through the same in-process pass.
Revert if the space server's copy needs so many allowlist entries that the
file stops being an audit trail.
