---
number: 288
title: Transport-Agnostic Inbound Event Seam (Poll-First)
status: proposed
created: 2026-06-25
spec: flow-triage-feeds-loop
superseded-by: null
---

# 288. Transport-Agnostic Inbound Event Seam (Poll-First)

## Status

Proposed (extracted from spec: flow-triage-feeds-loop)

## Context

The engine ingests tracker activity as a prose poll of `getInbox`; the named `TrackerEvent`
type exists only in the charter, there is no transport abstraction to swap, and webhooks are
explicitly deferred (charter G9, gap). DorkOS is local-first with no exposed endpoint to
receive a tracker's outbound webhooks, so the resume mechanism must be pull, and pull is also
the one path that works identically for shared, regular, and future agent-account identity
modes.

## Decision

Introduce a normalized **`TrackerEvent`** discriminated union and an **`InboundTransport`**
interface with a v1 **`PollingTransport`** (wrapping the adapter's `getInbox` + a durable
watermark cursor); the existing `InboxComment` becomes the payload of the `comment.added`
variant. The producer (poll now, webhook later) is selected by config and is a drop-in: the
reconcilers consume `TrackerEvent[]` and never know how an event arrived. Events are
**triggers, not truth** -- a reconciler re-reads the item's current state via the `PMClient`
before acting, with a `dedupeKey` and skip-self-authored rule keeping it idempotent. This is
the inbound dual of the outbound `PMClient`; Linear-specific parsing stays confined to the
`linear-adapter`.

## Consequences

### Positive

- Polling and webhooks are interchangeable producers; swapping the transport changes no engine
  code and no reconciler (charter G9), and requires no inbound endpoint in v1.
- Idempotent, re-derive-from-truth reconcilers tolerate duplicate, reordered, and missed
  events, so poll and webhook behave identically.

### Negative

- The second producer (webhook) is unproven until built; an interchangeability test (same
  events through a fake poll and a fake webhook producer) stands in for it.
- A normalized event union is more machinery than a bare `getInbox` poll; justified only
  because it is the seam every reconciler and the P5 server share.
