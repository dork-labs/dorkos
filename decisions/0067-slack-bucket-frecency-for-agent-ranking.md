---
number: 67
title: Use Slack Bucket Frecency for Agent Ranking
status: draft
created: 2026-03-03
spec: command-palette-10x
superseded-by: null
---

# 67. Use Slack Bucket Frecency for Agent Ranking

## Status

Draft (auto-extracted from spec: command-palette-10x)

## Context

The command palette's zero-query state shows "Recent Agents" sorted by frecency. The existing algorithm uses a linear formula (`useCount / (1 + hoursSinceUse * 0.1)`) which doesn't decay naturally — agents used heavily months ago remain ranked high for too long. Slack's Quick Switcher uses a bucket-based system that is battle-tested at scale and decays more naturally.

## Decision

Adopt Slack's 6-bucket frecency system: timestamps fall into buckets (4h=100pts, 24h=80pts, 72h=60pts, 1w=40pts, 1mo=20pts, 3mo=10pts). Score = `totalCount * bucketSum / min(timestamps.length, 10)`. Store up to 10 timestamps per agent in localStorage under a new key (`dorkos:agent-frecency-v2`). The old key is abandoned (no migration — start fresh).

## Consequences

### Positive

- More natural decay curve — old high-frequency items lose ranking as timestamps age out of high-value buckets
- Battle-tested at scale (Slack Quick Switcher, Firefox URL bar)
- Pure client-side, no server state, same `useSyncExternalStore` pattern
- Denominator cap at 10 prevents score inflation from historical usage

### Negative

- Slightly more complex than the linear formula (6 bucket boundaries vs. one formula)
- Existing frecency data is abandoned (users start fresh with the new key)
- Timestamps array (max 10 entries) uses more storage per agent than the old single `lastUsed` field
