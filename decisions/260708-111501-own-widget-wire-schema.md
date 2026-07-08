---
id: 260708-111501
title: Own the widget wire schema in @dorkos/shared instead of adopting json-render or A2UI
status: proposed
created: 2026-07-08
spec: gen-ui-tier1
superseded-by: null
---

# 260708-111501. Own the widget wire schema in @dorkos/shared instead of adopting json-render or A2UI

## Status

Proposed

## Context

The Tier-1 widget format could adopt an existing wire format: Vercel's json-render (Zod catalog + React renderer, shadcn components, but a fast-moving single-vendor lab project) or Google's A2UI (multi-vendor, A2A-native, but its React renderer is immature and v1.0 is still an RC). Widget JSON is persisted inside session transcripts, so the wire format is a long-term compatibility commitment in a way a rendering library is not.

## Decision

We will define our own versioned Zod schema (`@dorkos/shared/ui-widget`, `version: 1`, discriminated-union node catalog) and hand-roll the recursive renderer over shadcn primitives, borrowing json-render's catalog-constrained design rather than its format. If A2UI matters for the A2A gateway once v1.0 stabilizes, we add an emitter/adapter — the flat catalog shape keeps that translation mechanical.

## Consequences

### Positive

- Transcript compatibility is under our control; no coupling to a lab project's release cadence.
- The renderer is small, fully theme-integrated, and extensible by skills/extensions later (catalog registration).

### Negative

- We forgo json-render's prebuilt components and future improvements; catalog growth is on us.
- A future A2UI interop requires a translation layer we must write and maintain.
