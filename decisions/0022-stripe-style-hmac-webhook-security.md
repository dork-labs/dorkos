---
number: 22
title: Use Stripe-Style HMAC-SHA256 for Webhook Security
status: draft
created: 2026-02-24
spec: relay-external-adapters
superseded-by: null
---

# 22. Use Stripe-Style HMAC-SHA256 for Webhook Security

## Status

Draft (auto-extracted from spec: relay-external-adapters)

## Context

The webhook adapter receives inbound HTTP POST requests from external services. These must be authenticated to prevent spoofing. The adapter also sends outbound POST requests that recipients need to verify. Industry patterns include GitHub-style HMAC (body only), Stripe-style HMAC (timestamp-prefixed), and token-based auth. Replay attacks, timing attacks on signature comparison, and secret rotation are additional concerns.

## Decision

Use Stripe-style timestamp-prefixed HMAC-SHA256 with four-layer defense: (1) HMAC-SHA256 signature over `"${timestamp}.${rawBody}"`, compared with `crypto.timingSafeEqual()`, (2) timestamp window of 300 seconds, (3) nonce tracking with in-memory Map (24h TTL, 5-minute prune interval), (4) idempotency key per event. Support dual-secret rotation — verify against both current and previous secret during a 24h transition window.

## Consequences

### Positive

- Industry-standard pattern (Stripe, GitHub) — well-understood by integrators
- Timestamp prefix prevents replay attacks outside the 5-minute window
- Nonce tracking closes the gap within the timestamp window
- `crypto.timingSafeEqual` prevents timing side-channel attacks
- Dual-secret rotation enables zero-downtime secret changes

### Negative

- Raw body must be captured before JSON parsing — requires `express.raw()` middleware on webhook routes
- In-memory nonce Map loses history on server restart — brief replay window (acceptable for single-process; Redis is the upgrade path)
- Nonce Map consumes memory proportional to request volume (pruned every 5 minutes, bounded by 24h TTL)
