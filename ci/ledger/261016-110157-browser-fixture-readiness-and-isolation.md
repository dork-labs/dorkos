---
id: 261016-110157
title: Wait for the app shell and isolate shared browser fixtures
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard]
prs: [2945]
ratchet-release: []
field-changes: []
---

The bc34 merge-group browser run failed the existing canvas reload case twice because the right-panel toggle was absent while the real AppShell had not mounted. All six Recovery cases and all four unit shards passed in that run. Preserve that failure and its retry trace; it is distinct from the earlier disabled-Edit failures.

Use the existing app-readiness precondition before probing the right panel. The strengthened existing case holds the real AppShell module across reload, then releases it without widening the helper's one-second lookup or application deadlines. Independently qualified causal RED on the old helper and GREEN with this precondition are prerequisites for this record's normal commit. Keep their actual receipts separately linked in the append result; do not infer hosted acceptance from a local pass.

The browser-driving project shares resettable scenario/session state. Its maintained project worker cap is one so local files cannot reset another file's active fixture. CI already uses one global worker; effective CI concurrency, required checks, retries, shards and deadlines are unchanged. This is local isolation hygiene, not a claimed hosted metric improvement. No ratchet release or CI steward field change is requested.

Validate the normal whole22 project and the helper's owning whole pulse2 file with default settings, plus normal finite lint/types, ledger schema/coverage, census, database, size, vocabulary and changelog checks. Revert or revise if the precondition stops being the real readiness boundary, the controlled case ceases to discriminate the old helper, or project isolation does not prevent reset interference. Do not drop coverage or rearm a failed queue without classifying its evidence.
