---
id: 261119-055020
title: Keep chat birth separate from runtime binding
status: proposed
created: 2026-11-19
spec: stored-model-launch-reconciliation
superseded-by: null
---

# 261119-055020. Keep chat birth separate from runtime binding

## Status

Proposed for [stored-model-launch-reconciliation](../specs/stored-model-launch-reconciliation/02-specification.md). Implementation and verification remain outstanding.

## Context

A first metadata INSERT and a CLAIM intentionally seed permission differently. Client UUIDs, cache absence and imported native identity do not prove a new chat. A reusable owner/folder location is not a one-time chat receipt.

## Decision

Mint ordinary new chat ids through a distinct person-gated location operation, storing only durable owner/location allocation provenance. Load authenticated inputs before SQL, then revalidate the persisted allocation/source and durable ownership generation inside the same synchronous transaction as the existing first metadata INSERT and consumption, preserving its settings and origin-specific SQL. Keep valid allocations across restart/reopen with no TTL/cap or automatic allocation retry. Existing metadata carries the versioned pending→attempted/uncertain→positively established lifecycle. Legacy null stays conservative. Normal registered-agent allocation uses current person and exact agent identity without new folder confinement. Internal mint owners persist a typed internal variant of the same allocation table with their actual durable source identity, atomically with existing owner writes when available, without fake public owner/location values.

## Consequences

### Positive

- Metadata binding has no catalog/native discovery and keeps DOR4411 permission behavior.
- Saved drafts retain reliable provenance across restart, while imported or ambiguous chats stay compatible.
- No model/inference/dispatch reward is inferred from allocation or attempted handoff.

### Negative

- One small allocation table and atomic integration at existing first-write sites are required.
- Inert orphan allocations persist until a genuine explicit cleanup owner exists.
- The same storage closes internal queued/seat birth gaps through typed source congruence. Concrete transaction/rekey integration and real crash/race proof remain owed. No flags are added to unrelated owner tables.
