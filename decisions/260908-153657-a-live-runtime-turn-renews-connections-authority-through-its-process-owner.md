---
id: 260908-153657
title: A live runtime turn renews Connections authority through its process owner
status: accepted
created: 2026-09-08
spec: connections-runtime-turn-renewal
superseded-by: null
amends: null
---

# 260908-153657. A live runtime turn renews Connections authority through its process owner

## Status

Accepted.

## Context

A Connections bearer belongs to one runtime turn and currently expires four hours after it opens,
even when that exact turn remains productive for days. Bearer traffic, stored sessions, and runtime
history are unsafe liveness signals, while rotating the credential cannot update a running Codex
child's environment and would race OpenCode's directory-shared registration.

## Decision

We will keep the four-hour lease and let one server-owned supervisor renew the same bearer hourly
while it holds an opaque process-local permit and the runtime adapter proves exact active-turn
ownership through the synchronous commit boundary. Renewal will compare-and-set only expiry after
canonical authority revalidation and fresh post-await row, clock, permit, tombstone, and owner-slot
checks. It will never derive liveness from bearer use or durable state, and cancellation, teardown,
expiry, authority change, slot replacement, or restart will close or invalidate the permit without
revival. Per-operation connection, grant, revision, override, and approval checks remain in the
execution broker. We will retain Claude Code's
in-process capability path, Codex's fixed subprocess environment, and OpenCode's directory-scoped
registration rather than replacing them with one transport.

## Consequences

### Positive

- Legitimate Claude Code, Codex, and OpenCode turns can keep Connections authority for days without
  changing credentials or widening claims.
- Traffic cannot prolong its own authority, and loss of the process owner leaves at most the
  existing four-hour exposure.
- One lifecycle contract preserves each runtime's proven attachment and teardown boundary.

### Negative

- A bearer copied from a legitimately active days-long turn can remain useful while that trusted
  supervisor keeps renewing, although it expires within four hours after the last legitimate
  renewal.
- The server must own timers, transient storage retries, duplicate-callback convergence, and a
  terminal lease-loss state for every Connections-capable turn.
- Same-bearer renewal does not reduce secret lifetime during a live turn; rotation or
  proof-of-possession would require a separate architecture change.
