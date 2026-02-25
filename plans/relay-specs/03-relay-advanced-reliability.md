---
title: "Relay Advanced Reliability"
spec: 3
order: 3
status: done
blockedBy: [2]
blocks: [5]
parallelWith: [4]
litepaperPhase: "Phase 2 — Advanced Reliability"
complexity: medium
risk: low
estimatedFiles: 6-10
newPackages: []
primaryWorkspaces: ["packages/relay", "apps/server", "apps/client"]
touchesServer: true
touchesClient: true
verification:
  - "Rate-limited sender gets rejection after exceeding threshold"
  - "Circuit breaker trips after repeated delivery failures to an endpoint"
  - "Circuit breaker auto-resets (half-open → closed) after cooldown period"
  - "Backpressure signal returned when inbox exceeds size threshold"
  - "All reliability features are configurable via config file"
  - "Relay works correctly with all reliability features disabled (defaults)"
  - "Client panel shows circuit breaker states and rate limit hits"
notes: >
  Can run in PARALLEL with Spec 4 (External Adapters) — they're independent
  additions to the Spec 2 foundation. Both must complete before Spec 5.
  This spec adds well-understood reliability patterns (token bucket, circuit
  breaker state machine) — less architectural risk than Specs 1-2. Focus
  the /ideate session on choosing sensible defaults for a local agent system.
---

# Spec 3: Relay Advanced Reliability

## Prompt

```
Add advanced reliability features to the @dorkos/relay package — rate limiting, circuit breakers, and backpressure handling.

This spec builds on the existing Relay core library (Spec 1) and server integration (Spec 2). The core transport works. Now we harden it for production use where agents may generate high message volumes or encounter endpoint failures.

GOALS:
- Implement per-sender rate limiting in packages/relay/ — configurable limits on messages per time window per sender, with soft and hard thresholds
- Implement circuit breakers per endpoint pair — if deliveries between two endpoints fail repeatedly, trip the circuit to prevent cascading failures, auto-reset after cooldown
- Implement backpressure handling — when an endpoint's mailbox grows beyond a threshold, signal senders to slow down or reject new messages with a clear error
- Add rate limit and circuit breaker configuration to the Relay config file (~/.dork/relay/config.json or similar)
- Add HTTP endpoints for viewing rate limit status, circuit breaker state, and backpressure metrics
- Update the client Relay panel to display reliability status (circuit breaker states, rate limit hits, backpressure warnings)
- Tests for all reliability features, especially edge cases (rapid burst, slow consumer, endpoint recovery)

INTENDED OUTCOMES:
- A misbehaving agent that sends too many messages gets rate-limited (soft: warning signals, hard: message rejection)
- If deliveries to an endpoint fail repeatedly, the circuit breaker trips and prevents further attempts until the endpoint recovers
- If an endpoint's inbox fills up (slow consumer), new senders get a backpressure signal rather than unbounded queue growth
- All of these are configurable, with sensible defaults that work out of the box
- The reliability layer is transparent — it logs/signals what's happening so operators can diagnose issues

KEY DESIGN CONSIDERATIONS:
- Rate limiting should use a token bucket or sliding window algorithm
- Circuit breakers should follow the standard states: closed (normal) → open (tripped) → half-open (testing recovery)
- Backpressure should be based on mailbox size (number of unprocessed messages in new/ + cur/)
- All reliability features should be optional and configurable — Relay should work fine without them (they just add safety at scale)
- These features should NOT break the at-most-once delivery guarantee — they add rejection, not retry

REFERENCE DOCUMENTS:
- meta/modules/relay-litepaper.md — Phase 2 roadmap: "Advanced Reliability. Rate limiting per sender. Circuit breakers per endpoint pair. Backpressure handling."
- docs/plans/2026-02-24-relay-design.md — mentions rate limiting in SQLite index (line 43), circuit breakers in access control section
- docs/plans/2026-02-24-litepaper-review.md — OQ-6 (backpressure handling) is directly addressed by this spec
- research/mesh/access-control-coordination.md — circuit breaker patterns, rate limiting approaches

CODEBASE PATTERNS:
- The existing budget enforcement in packages/relay/ is the model — it rejects messages before delivery. Rate limiting and circuit breakers follow the same "check before delivery" pattern.
- SQLite index already tracks message counts and timing — rate limit checks can query this efficiently
- Configuration pattern: see how ~/.dork/relay/ config files work (from Spec 1)

OUT OF SCOPE:
- External adapters (Spec 4)
- Pulse/Console migration (Spec 5)
- Distributed rate limiting (DorkOS is single-machine)
```

## Context for Review

This spec is less architecturally complex than Specs 1-2 — it's adding well-understood reliability patterns to an existing system. The /ideate session should focus on:
- Choosing the right rate limiting algorithm (token bucket vs sliding window vs fixed window)
- Defining sensible defaults (what rate limits make sense for a local agent system?)
- How circuit breaker state persists across restarts (SQLite? in-memory only?)
- The backpressure signaling mechanism (how does a sender learn about backpressure?)
