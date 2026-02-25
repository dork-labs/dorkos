---
number: 11
title: Use NATS-Style Hierarchical Subject Matching
status: proposed
created: 2026-02-24
spec: relay-core-library
superseded-by: null
---

# 0011. Use NATS-Style Hierarchical Subject Matching

## Status

Proposed (auto-extracted from spec: relay-core-library)

## Context

Relay needs a routing mechanism that supports both point-to-point messaging and pub/sub. Three algorithms were evaluated: trie (NATS production approach, O(tokens) but complex), pre-compiled regex per pattern (simple, O(N) per publish), and linear token scan (simplest, O(N) per publish). DorkOS will have <1,000 subscriptions for the foreseeable future.

## Decision

Use NATS-style dot-delimited hierarchical subjects with `*` (match one token) and `>` (match rest) wildcards. Implement matching as a linear token scan (~30 lines). Expose a `SubjectMatcher` interface for future trie upgrade if scale demands it.

## Consequences

### Positive

- Proven pattern (NATS, MQTT, D-Bus) — well-understood semantics
- Enables both point-to-point and pub/sub in a single model
- Implementation is small, correct, and easy to test
- Subject taxonomy is convention, not enforced by code — flexible for future modules

### Negative

- Linear scan is O(N) per publish — not suitable for >10,000 subscriptions
- No built-in queue groups or load balancing (can be added later)
