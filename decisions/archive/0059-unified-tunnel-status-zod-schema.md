---
number: 59
title: Unify Tunnel Status into Single Zod Schema
status: archived
created: 2026-03-01
spec: tunnel-remote-access-overhaul
superseded-by: null
---

# 59. Unify Tunnel Status into Single Zod Schema

## Status

Draft (auto-extracted from spec: tunnel-remote-access-overhaul)

## Context

Three different tunnel status shapes exist across the codebase: TunnelManager's internal status (`connected, url, port, startedAt`), the health endpoint response (same four fields), and the config endpoint response (`enabled, connected, url, authEnabled, tokenConfigured`). This inconsistency causes confusion, type mismatches, and forces consumers to handle multiple shapes.

## Decision

Create a single superset `TunnelStatusSchema` in `packages/shared/src/schemas.ts` with all fields: `{ enabled, connected, url, port, startedAt, authEnabled, tokenConfigured, domain }`. All three consumers (TunnelManager, health route, config route) use this unified type. The config route enriches core fields with auth/token status at response time rather than maintaining a separate shape.

## Consequences

### Positive

- Single source of truth for tunnel status shape
- Type-safe across server, client, and shared packages
- Eliminates field-missing bugs when consuming tunnel status
- Zod validation ensures runtime type safety

### Negative

- TunnelManager must now track `authEnabled`, `tokenConfigured`, and `domain` fields (minor responsibility expansion)
- Existing consumers need migration (one-time cost)
