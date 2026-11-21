---
id: 261119-040949
title: Own native verification through run lifelines
status: proposed
created: 2026-11-19
spec: opencode-run-custody
superseded-by: null
amends: null
---

# 261119-040949. Own native verification through run lifelines

## Status

Proposed. [The OpenCode run custody spec](../specs/opencode-run-custody/02-specification.md) defines the implementation and evidence required for acceptance.

## Context

Tests, evals and harness smoke start native OpenCode work whose lifetime can exceed the Node process that requested it. Cooperative shutdown covers ordinary exit. A forcibly killed run can leave both a worker and its native children alive. These entry points need a shared ownership boundary that identifies and stops the run's exact resources after its owner disappears.

## Decision

Give each eligible scope a guardian with independent lifelines from the run main and the scope owner. The guardian acquires and records authority at creation through an owned POSIX group, a Windows Job, or the exact container on the selected Docker daemon. Either lifeline closing starts idempotent cleanup. The receipt distinguishes confirmed cleanup from uncertain ownership or termination. Keep existing paid admission ahead of acquisition and leave production lifetime with its existing owner.

## Consequences

### Positive

- Callers can share the custody contract and prove cleanup after the run owner exits.
- Receipts retain actual native or daemon identity through leader exit and distinguish a cleanup attempt from an observed terminal result.

### Negative

- Each supported backend needs its own acquisition, cancellation and termination evidence.
- Guardian and stream ownership add setup and teardown work. Escaped descendants and lost daemon access remain outside confirmed custody.
