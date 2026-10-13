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

Record ordinary lower/remove-only regeneration of the max-lines ratchet and route census for the Doc channel foundation reconciled with pinned Main a4a72db97763896c8dcf15c511eecfae22b6f45a. Normal hooks and required CI remain in force.

Metric: total saved line allowance above the 500-line threshold, calculated as the sum of max(cap - 500, 0) across the official cap map. Main a4a72 has 156 entries and 43,664 lines of excess allowance. The final regenerated map has 152 entries and 42,767 lines of excess allowance: a reduction of 897. Four entries were removed and 24 lowered; no entry was added or raised. This measures the saved cap map, not runtime speed or measured source-line counts.

Hypothesis and target: reduce that allowance by at least one line by 2026-10-13, without introducing or increasing any cap, while preserving the admitted route census. The measured reduction meets that target. The completed ordinary six commands updated and verified the max-lines lowered subset, regenerated and verified the whole route census, and passed the CI census and ledger checks. All six commands exited zero; the route baseline remained byte-identical. The initial first-command regeneration failure and subsequent stale shrinking-allowance verification remain recorded as negative results. Function-preserving extractions into eight existing production files introduce no new file or allowance.

Original runtime owners, SDK dispatch, private construction keys, live receiver binding, cancellation, budgets and first-failure cleanup remain intact. Main live configuration, computer admission and native pause refusal/tracking compose with the original Room lifetime. Default, native bootstrap/setup and home-resume child helpers use explicit load-aware startup IPC waits with a nominal 10-second budget and finite 40-second ceiling, bounded startup hooks, unchanged scenario bodies and strict two-second drain. Temporary diagnostics are restored; original phase markers remain. The fresh affected workspace typecheck after the eight-file extraction passed 49/49 tasks with zero TypeScript diagnostics. Its inputs and regression inputs remain unchanged through the baseline-JSON-only update.

Regression coverage is independently qualified as 101 retained whole files with 2,568 assertions plus eleven freshly executed affected whole files with 567 assertions: 112 whole files and 3,135 passing assertions. All eleven fresh files passed with zero failures, pending or todo cases. Actual component and separate saved-evidence union receipts preserve their physical references; this is composed coverage, not one fresh 112-file invocation. Two additional adapter conformance files are outside that count. Their default mocked modes passed 222 assertions, including E1/E2 once per Codex exec, Codex app-server and OpenCode instance. The 22 exact source-declared optional or live-only conditional skips remain separately recorded and uncredited. Neither outside file adds to the original 112-file coverage, and no paid or live provider mode was enabled. Earlier failed overall results remain unchanged; partial passes from incomplete files and filtered diagnostics provide no whole-file credit. Two previously complete worktree-refresh suites outside the original scope remain historical separate receipts of 35 and three assertions.

The current a4 merge commit, postcommit coverage/DB checks and publication remain pending. Separate ordinary integration of pinned newer Main 0eaa45 must complete before shipping, with authentic source and parent review, the planned nine affected suites and appropriate ordinary checks. This record claims neither that integration nor protected CI or queue completion.

<!-- agent:provenance {"v":1,"harness":"codex"} -->
