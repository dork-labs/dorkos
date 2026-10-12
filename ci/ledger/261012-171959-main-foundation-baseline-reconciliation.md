---
id: 261012-171959
title: Reconcile Main and Foundation validation baselines
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [2673]
ratchet-release: []
field-changes: []
---

<!-- agent:provenance {"v":1,"harness":"codex"} -->

Reconcile the two generated baseline conflicts after integrating Main’s Hono routing with the Foundation document routes. This is hygiene: the change records the resolved source tree and keeps the existing checks in force, without a performance hypothesis or a computed verdict.

The max-lines seed combines authentic branch-only entries and chooses the lower existing cap for every shared path. The ordinary lower-only updater must then remove retired or under-limit entries and lower caps for actual shrinkage. A new or enlarged over-limit file must be refactored; this reconciliation does not raise the 500-line limit or any existing cap.

The route-census seed is Main’s authentic Hono baseline. After all reviewed route and owner composition changes are adopted, regenerate it from the complete composed server. Review the complete generated method/path inventory, including the Foundation document event, management and token routes, and keep the ordinary duplicate/overlap/shadow and route-count checks. The seed alone does not establish the final route inventory.

No required check, event trigger, retry, shard, worker, timeout, status, gate exemption or ratchet floor changes. Keep both baseline generation and unchanged validation results with the final source epoch; do not replace failures with a waiver or a manually invented count. Revise the source or revert a reconciliation that drops an intended route, changes guard behavior or requires a larger cap.

Before publication, run the unchanged max-lines and route-census checks, CI Steward census, ledger validation and same-commit coverage validation against the genuine base. The ledger filename/id must come from the ordinary ledger-new scaffold.
