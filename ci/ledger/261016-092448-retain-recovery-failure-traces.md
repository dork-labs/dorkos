---
id: 261016-092448
title: Retain failed file-save recovery traces
kind: hygiene
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard]
prs: [2945]
ratchet-release: []
field-changes: []
---

Recovery browser checks twice reached a ready document with Edit still disabled, but their spec explicitly disabled traces. That override also defeated a local CLI trace request. Retain traces only when this Recovery spec fails so the next failure preserves its DOM snapshots and request/response chronology for diagnosis. The Receipt spec remains trace-off.

This is diagnostic hygiene, not a readiness fix or evidence that the hosted cause is resolved. Assertions, case membership/order, serial mode, retries, timeouts, workers, screenshots, video and required statuses remain unchanged. The successful local trace-on run is supporting capture evidence only; it does not explain the hosted failure.

Revert or revise this retention setting if actual trace collection breaks the browser job or its artifact custody budget. Diagnose that failure without weakening the required checks. No metric, field-change or ratchet release is requested.
