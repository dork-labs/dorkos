---
slug: central-workspace-disposal
number: 260928-001526
created: 2026-09-28
status: specified
---

# Adopt workspace reconciliation disposal at the server root

## Intent and assumptions

DOR-2429 was explicitly selected after DOR-2428 / PR #2226 merged. Inventory all named root lifecycle concerns, then implement the smallest justified slice. The existing class already owns a synchronous terminal write fence and a five-second drain deadline. The root must actually own that lifetime, including shutdown before acquisition and failure after acquisition.

All files stay in the isolated `29c5` checkout, based on `5794f638160a68811382347356fd29b31ee2e911`. Autonomous shaping, implementation, independent review, normal merge queue and safe cleanup are authorized. No paid inference or live deployments.

## Sources and discovery

- [Existing class-local specification](../local-workspace-lifecycle/02-specification.md) and merged PR #2226.
- [Current root ownership inventory](root-ownership.md), including admission, startup rollback, concurrent shutdown, subscriptions, error continuation, budget and database/lock order.
- Root starts the reconciler at `apps/server/src/index.ts:1607` but loses its reference. Root teardown can stall before stopping later owners; startup's failure handler cleans only an offline fixture.
- Startup awaits before workspace construction. Merely hoisting a nullable reference misses shutdown-before-acquisition: startup could later acquire a new timer.
- Marketplace retention discards its unsubscribe, queues sweeps and mutates asynchronously. It cannot reuse the reconciler's synchronous write-fence proof.

## Decision

Use one workspace-specific lifecycle owner. Register the reconciler before start, make terminal state sticky, join repeated disposal, and call disposal before unrelated cleanup awaits at root shutdown and startup failure. Delegate the drain deadline to the proven class; add no new overall server deadline or generic disposal framework.

Do not coalesce all root cleanup or change HTTP admission in this slice. Those changes affect admin reset/restart continuations, streams, protected owners, database close and successor handoff together. Record scoped follow-ons rather than claiming broad safety.

## Alternatives

- A nullable root reference alone is smaller but misses late acquisition after shutdown.
- Root-wide disposal stack/admission/budget changes would combine independent policies and cross active Cloud/Community ownership.
- A small root-owned helper gives the sticky acquisition boundary and a real behavioral test seam; its cost must be challenged in independent review.

## Ownership and next step

Architecture approved the bounded slice. Community reports no current root edits. Cloud identity adoption stays outside `index.ts` and confirmed these sections clear; its later managed-remote consumer will coordinate after this slice. Preserve all their composition and contracts.

Proceed with the specification and focused implementation. No product decision remains unanswered; root-wide guarantees remain separately scoped work.
