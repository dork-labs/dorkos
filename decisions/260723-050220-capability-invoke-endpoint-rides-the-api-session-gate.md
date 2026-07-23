---
id: 260723-050220
title: The generic capability invoke endpoint rides the /api session gate, never the MCP carve-out
status: accepted
created: 2026-07-23
spec: capability-registry
superseded-by: null
---

# 260723-050220. The generic capability invoke endpoint rides the /api session gate, never the MCP carve-out

## Status

Accepted

## Context

`dorkos call <capability-id>` needed a uniform server path to invoke any registered capability, including ones with no dedicated HTTP route. A generic actuation endpoint over the whole registry (mutations included) concentrates risk, and DorkOS already has two distinct auth postures: the `/api/*` session gate (opt-in login, zero-overhead pass-through when off) and the external `/mcp` stack with its tokenless read-only carve-out.

## Decision

We will expose `POST /api/capabilities/:id/invoke`, mounted behind the app-wide `sessionGate` exactly like every `/api/*` route, sharing no code path with the MCP auth stack, so mutating capabilities are never tokenlessly reachable. The route validates input through the capability's Zod schema before invoking, maps unknown ids to 404 and `CapabilityToolError` to 400 with the handler's own payload, and never leaks stack traces. Curated CLI verbs whose frozen `--json` contracts predate the registry keep their existing routes when the capability's input shape differs; `dorkos call` is the capability-shaped path and validates ids against the live catalog before the round-trip.

## Consequences

### Positive

- Every capability is reachable programmatically with one uniform contract, without per-capability route work.
- Auth posture is inherited, not invented: login-on gates it with 401s; login-off matches the established local trust model, and phase 3's tiers/approvals have a single choke point to instrument.

### Negative

- Until phase 3 lands, any local process can invoke mutating capabilities on a login-off instance — the same posture as every existing `/api/*` mutation, but now via one generic door; tier enforcement must target this endpoint first.
- Two paths to the same behavior exist for some operations (curated route + invoke endpoint); divergence is bounded by both wrapping the same handlers.
