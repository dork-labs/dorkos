---
id: 261115-223354
title: Preserve recovery session launch requirements
status: accepted
created: 2026-11-15
spec: room-handoff-failed-seat-recovery
superseded-by: null
amends: null
---

# 261115-223354. Preserve recovery session launch requirements

## Status

Accepted architectural direction after independent re-review and root approval. Implementation is authored and undergoing targeted verification; acceptance does not claim shipped behavior or a passing full recovery oracle. This supersedes the specification's earlier no-new-table assumption.

## Context

A qualifying failed Claude room seat needs one fresh session for new work while retaining its actual account and billing choice. The existing mover publishes its new binding but keeps its launch hint only in memory, so restart can lose that choice. Session settings cannot represent required billing, and verified native bindings cannot honestly describe a session that has never launched. A room-owned marker would also lose authority when the destination is unseated or addressed directly.

## Decision

We will store one immutable recovery launch requirement and a server-only reference owned by the destination session metadata. The shared mover will publish requirement, reference and expected-binding CAS in one transaction after current guards, retaining unique prior-failure consumption. Every Claude launch surface will enforce actual runtime/root/inference/billing constraints against final resolved configuration before SDK effects, including after native settlement; aliases must preserve identity atomically and refuse conflicts. Pending launch requires a current owned handoff attempt, and restart leaves it blocked until explicit guarded reauthorization without replay or repeat source consumption. No path may manufacture native proof, launch before room ownership, or fall back to another account or bill.

## Consequences

### Positive

- Restart, unseat, aliases and direct sends cannot silently unlock default billing.
- Existing mover, launch guards and native-proof semantics retain their ownership.
- Unknown authority refuses without widening the prior-server-error recovery classifier.

### Negative

- One narrow table and one session metadata reference add migration and lifecycle obligations.
- Final launch resolution and alias/deletion paths need strict checks and regression coverage.
- Pending recovery after restart may require explicit new action; generic historical failures remain unsupported.

Details and required proof: [specification](../specs/room-handoff-failed-seat-recovery/02-specification.md) and [durable contract](../specs/room-handoff-failed-seat-recovery/07-required-launch-proposal.md). Migration number follows actual integrated ancestry; none is reserved.
