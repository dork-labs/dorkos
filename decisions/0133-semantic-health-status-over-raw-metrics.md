---
number: 133
title: Semantic Health Status Over Raw Metrics
status: accepted
created: 2026-03-15
spec: relay-panel-redesign
superseded-by: null
---

# 133. Semantic Health Status Over Raw Metrics

## Status

Accepted

## Context

The Relay Panel health bar displayed four raw counters — total messages, delivered, failed, dead letters — labeled "today" but actually showing all-time counts because `TraceStore.getMetrics()` had no date filter. Equal visual weight across all four stats meant a 90% failure rate was hidden in plain sight: all numbers appeared equally prominent, so a user glancing at the bar could not assess system health without mental arithmetic. Trust was further destroyed by the mislabeled "today" stat. A design critique concluded that the bar failed its primary job: letting users know in under one second whether their relay system is working.

## Decision

Replace the four raw-number stats bar in `RelayHealthBar.tsx` with a semantic three-state indicator — healthy, degraded, critical — computed from failure rate thresholds (5% degraded, 50% critical) and adapter connectivity. The bar leads with a colored status dot and a human-readable message ("3 connections active," "Telegram: 12 failures in last hour," "90% failure rate"). Detailed metrics (raw counts, latency) are accessible via a hover tooltip in the healthy state and remain available through the existing `DeliveryMetricsDashboard` dialog. The `getMetrics()` server function is fixed to accept a `since` parameter defaulting to the last 24 hours, making "today" accurate.

## Consequences

### Positive

- System health is assessable in under one second without mental arithmetic.
- Failure states (degraded, critical) are impossible to miss — the colored dot and failure-specific message are the primary display.
- "Today" label becomes honest once `getMetrics()` applies the 24-hour date filter.
- Detailed raw numbers remain accessible for power users via tooltip and dialog.

### Negative

- At-a-glance raw message counts are no longer the primary display; users who habitually checked the numbers will find them one hover away instead of immediately visible.
