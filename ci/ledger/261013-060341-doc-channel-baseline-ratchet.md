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

Record ordinary lower/remove-only regeneration of the max-lines ratchet and reconciliation of the route census for the Doc channel integration with Main’s Hono stack. The max-lines baseline is a pipeline-covered input; existing normal hooks and required CI remain in force.

Metric: total saved line allowance above the 500-line threshold, calculated as the sum of max(cap - 500, 0) across the official baseline. The authentic Main8a3 baseline has 156 entries and 43,937 lines of excess allowance. This measures the saved cap map, not runtime speed or measured source-line counts.

Hypothesis and target: reduce total saved allowance above the 500-line threshold by at least 920 lines from the 43,937-line baseline by 2026-10-13, without increasing any individual cap, while the regenerated route census continues to represent the real admitted routes. Observed after all six ordinary regeneration commands passed: 152 entries and 43,017 lines of saved allowance, a reduction of 920 lines from the authentic Main8a3 baseline. This is a saved-cap reduction, not a runtime performance gain or completed Main12eb validation.

Fresh correctness evidence after the upload-storage close extraction: the affected workspace typecheck completed 49/49 tasks with zero diagnostics, and 29 selected whole files passed 486 assertions. The earlier 62-file, 1,489-assertion result is historical evidence from before that close extraction. These checks precede the Main12eb integration. Revisit the integration if regeneration raises a cap, removes a real route, admits a fabricated or retired principal, or permits a stale write or stream. Preserve actual caller facts, original operation ownership and Main behavior while fixing the concrete defect.

<!-- agent:provenance {"v":1,"harness":"codex"} -->
