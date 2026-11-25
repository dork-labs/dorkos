---
id: 261125-040533
title: api-lint's hand-registered-path skips routes on the permanent hand-route allowlist
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4978 moves every route onto the capability mount except a reasoned allowlist (streams, bytes, callbacks, sign-in handshakes, HTML pages, health/docs, invoke) in `apps/server/src/http/hand-routes/allowlist.ts`. The advisory `hand-registered-path` rule now skips an allowlisted literal method and path, so its count tracks only routes still to move. Nothing measurable in the pipeline should change: the rule stays advisory until the pending list is empty. Revert if the rule stops counting a route that is not on the allowlist.
