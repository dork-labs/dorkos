---
id: 261126-010304
title: apps/server/src/middleware/ is a Security path
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

The server's middleware decides who reaches the app before any route runs: the `/mcp` gate (`mcp-auth.ts`), the host
and managed-host guards, the remote access switch, agent identity, the second-factor gate, browser origin checks and
the rate limits. None of `apps/server/src/middleware/` was in `SECURITY_PATH_PATTERN`, so a change there could merge
without Security's review (found by the test-sweep session during DOR-4922). The pattern's `apps/server/src/(http|routes)/`
alternative becomes `(http|routes|middleware)` in `security-gate.yml`, the reviewed fixture and
`tools/security-approve/Policy.swift`, kept equal by the parity test, with two path rows; Security updates its
installed local checker to match. Revert only if the folder stops holding any request gate.
