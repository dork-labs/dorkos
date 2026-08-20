---
id: 260819-234827
title: Every user-facing message is one of four kinds (Attention, Activity, Suggestion, Feedback) with three tiers (Blocking, Notable, Quiet)
status: proposed
created: 2026-08-19
spec: notification-system
superseded-by: null
---

# 260819-234827. Every user-facing message is one of four kinds (Attention, Activity, Suggestion, Feedback) with three tiers (Blocking, Notable, Quiet)

## Status

Proposed. Implemented across DOR-1383..DOR-1391 (2026-08-20); accept via /adr:review.

## Context

DorkOS accumulated ~14 independent attention systems — two "needs attention"
engines with different rules, toasts, banners, promos, tours, celebrations,
title badges, a tray count — with no shared vocabulary, no coordinator, and no
answer to "how do I tell the user something?". External research converged on
the same shape everywhere (Linear, Slack, Apple's interruption tiers): separate
the standing "needs you" state from point-in-time events, keep marketing out of
both, and make loudness an explicit tier.

## Decision

Every message to the operator is exactly one of four kinds, each with one home:
**Attention** (standing condition — mirrored on every surface, no read state,
clears only on resolution, then becomes a history row with its outcome),
**Activity** (event — the Inbox, per-item read state), **Suggestion** (the
product talking — the bottom slot only, never a push, never the Inbox),
**Feedback** (response to the operator's own action — inline in the control;
toast only when the consequence is off-screen). Attention and Activity carry a
tier: **Blocking** (the only tier that escalates or makes sound), **Notable**
(OS notification only while away, silent), **Quiet** (history + unread weight
only). Pipeline invariants: never notify the operator about their own action;
presence suppresses; channels get louder one at a time; answering anywhere
settles everywhere.

## Consequences

### Positive

- One vocabulary replaces fourteen ad-hoc systems; contributors and agents
  learn one page.
- "Needs you" surfaces become honest — nothing dismissible-but-unresolved, no
  idle nudges masquerading as urgency.
- Loudness is a reviewable property of a kind, not a per-call-site choice.

### Negative

- Every existing surface must be classified, and misclassification is now a
  design bug rather than a local styling choice.
- The four-kind boundary must be policed in review (a promo that toasts is now
  a rule violation, not a taste difference).
