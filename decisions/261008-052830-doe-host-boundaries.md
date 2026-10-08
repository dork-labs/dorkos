---
id: 261008-052830
title: Doe uses platform boundaries and explicit inference sources
status: accepted
created: 2026-10-08
spec: doe-runtime
superseded-by: null
---

# 261008-052830. Doe uses platform boundaries and explicit inference sources

## Status

Accepted. Implemented by the Doe runtime and its standalone engine.

## Context

The standalone engine owns full model records but does not know DorkOS accounts, tools, permissions or display events. Platform credits currently describe one protocol per runtime. Doe supports several transports and must never silently change the person's bill.

## Decision

The host adapts AgentRuntime, uses EventLog for display and engine SQLite for model history, and supplies direct Harness resources. Tool metadata is registry-derived; execution uses authenticated DorkOS MCP with per-turn caller scope. Store explicit inference source and compatible model configuration per session, resolving secret references lazily. Extend credits formats compatibly without changing existing runtimes' single-format behavior.

## Consequences

### Positive

- Existing caller gates, memory, credentials and stream semantics remain authoritative.
- New capability contributions appear without another hand-maintained tool catalog.
- Model context remains lossless across display retention and compaction.
- Missing credits refuse without charging a different account.

### Negative

- Model and display persistence are intentionally distinct stores.
- Host naming and context rendering must preserve exact callable aliases.
- Shared credits contracts require cross-runtime regression coverage.
