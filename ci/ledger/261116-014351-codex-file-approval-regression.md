---
id: 261116-014351
title: Prove native Codex file-change approval refusals
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox, wf.codex-binary-macos.codex-binary-macos]
prs: []
ratchet-release: []
field-changes: []
---

DOR-3597 adds native file-change approval regression cases to the existing
pinned-binary suite, alongside modeled RPC and shared-path tests. A sealed
local scripted Responses service drives the real binary, with throwaway homes
and no credentials. Native ordinary patches must ask and succeed, protected
patches must receive a refusal without an answerable card, and Git metadata
must remain protected below Full but writable at Full.

This records regression coverage for an approval-policy fix, not a pipeline
performance experiment. Existing secret canaries, positive controls, timeout,
protection-start census and modes remain unchanged. No workflow, required
check, shard, retry, quarantine, floor or judge changes.

Revert or repair the proof if it stops observing a native file-change request,
if the ordinary patch control stops writing, or if removing the policy does
not fail its intended pre-broker assertion. An unsupported tool response is
an inconclusive spike, never a passing native denial.
