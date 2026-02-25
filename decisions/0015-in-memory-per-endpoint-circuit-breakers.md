---
number: 15
title: Use In-Memory Per-Endpoint Circuit Breakers
status: proposed
created: 2026-02-24
spec: relay-advanced-reliability
superseded-by: null
---

# 15. Use In-Memory Per-Endpoint Circuit Breakers

## Status

Proposed (auto-extracted from spec: relay-advanced-reliability)

## Context

The Relay module needs circuit breakers to prevent cascading failures when an endpoint's Maildir directory is corrupted, full, or its subscription handler consistently throws. Two scope decisions were needed: (1) per-endpoint vs per-sender-endpoint pair granularity, and (2) in-memory vs persistent state. DorkOS is a single-machine, single-process system.

## Decision

Circuit breakers are scoped per-endpoint (keyed by endpoint hash) with in-memory state only (`Map<string, CircuitBreakerState>`). State resets to CLOSED on restart. The standard three-state machine is used: CLOSED → OPEN (after N failures) → HALF_OPEN (after cooldown) → CLOSED (after successful probes).

## Consequences

### Positive

- Per-endpoint scope is simpler (one Map entry per endpoint, not a Map of Maps)
- Failure modes are endpoint health issues (broken handler, full disk), not sender-specific — per-endpoint gives a coherent recovery story
- In-memory state means zero disk I/O for state transitions
- Restart resets all breakers to CLOSED, giving endpoints a fresh chance; if still broken, failures quickly reopen the breaker

### Negative

- State is lost on restart (acceptable for local systems — fast re-detection)
- Cannot distinguish sender-specific failures at the same endpoint (better handled by access control rules)
