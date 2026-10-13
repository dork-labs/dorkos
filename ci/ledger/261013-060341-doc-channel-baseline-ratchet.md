---
id: 261013-060341
title: Reconcile Doc channel size and route baselines
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [2673]
ratchet-release: []
field-changes: []
---

Record ordinary lower/remove-only regeneration of the max-lines ratchet and reconciliation of the route census for the Doc channel integration with pinned Main12eb’s Hono stack. The max-lines baseline is a pipeline-covered input; normal hooks and required CI remain in force.

Metric: total saved line allowance above the 500-line threshold, calculated as the sum of max(cap - 500, 0) across the official baseline. The authentic pinned Main12eb baseline has 156 entries and 43,771 lines of excess allowance. This measures the saved cap map, not runtime speed or measured source-line counts.

Hypothesis and target: reduce total saved allowance above the 500-line threshold by at least 917 lines from the 43,771-line baseline by 2026-10-13, without increasing any individual cap, while the regenerated route census continues to represent the real admitted routes. Observed after all six ordinary regeneration commands passed: 152 entries and 42,854 lines of saved allowance, a reduction of 917 lines. Four cap entries were removed and 24 were lowered; no new or increased caps were admitted. Both whole route-census update and verification reports passed, and the CI census and ledger schema checks completed successfully.

Correctness evidence for the Main12eb integration: the affected workspace typecheck completed 49/49 tasks with zero TypeScript diagnostics, the ordinary Shared build passed, and 79 selected whole files passed 2,406 assertions. The accepted regression union retains 62 whole files and 1,494 assertions under a reviewed unchanged-input association, plus 17 whole files and 912 assertions after correcting one isolated test environment default. The correction changed no production code, type contract or test assertion. Final merge commit, protected CI and publication remain pending. Revisit the integration if a cap grows, a real route is lost, a fabricated or retired principal is admitted, or a stale write or stream is permitted. Preserve actual caller facts, original operation ownership and Main behavior while fixing any concrete defect.

<!-- agent:provenance {"v":1,"harness":"codex"} -->
