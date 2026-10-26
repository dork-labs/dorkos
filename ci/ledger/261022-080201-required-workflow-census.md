---
id: 261022-080201
title: Track main-sourced security workflow and org-rule drift
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

Required workflow source identity was outside CI Steward's model. Track the
trusted repository, path and main ref separately from named status contexts.
Census validates every job and trigger; collector includes the workflow in queue
and PR timing and performs read-only org-rule reconciliation. `census --live`
compares the live organization rule, scope, source identity, active enforcement,
and an explicitly visible empty bypass list. Missing or hidden data refuses.

This is a promotion prerequisite for DOR-3223, not activation. No GitHub rule or
access changes. Until the coordinator creates the rule, live comparison correctly
reports it missing; ordinary offline census still passes. Hosted required-workflow
merge_group execution and the multi-entry queue chain remain unproven until capture.
Revert if valid main-sourced rules are misclassified; never hide unreadable evidence.
