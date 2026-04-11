---
number: 227
title: Hot-Toggle External MCP Access via Middleware Gate
status: proposed
created: 2026-04-05
spec: external-mcp-access
superseded-by: null
---

# 227. Hot-Toggle External MCP Access via Middleware Gate

## Status

Proposed

## Context

The external MCP server at `/mcp` was previously always-on in production with no way to disable it. Users who want to restrict external tool access had no mechanism short of stopping the DorkOS server. A toggle is needed, but the implementation approach matters: conditionally mounting the route at startup requires a server restart, while a middleware gate allows instant toggling.

## Decision

Always mount the `/mcp` route. Add a `requireMcpEnabled` middleware that checks `configManager.get('mcp')?.enabled !== false` on each request and returns 503 Service Unavailable when disabled. Default `mcp.enabled` to `true` to preserve current behavior. The config change takes effect immediately — no restart needed.

## Consequences

### Positive

- Instant feedback: toggle in UI → next MCP request is blocked/allowed
- Consistent with how relay and tasks feature flags work (config-driven, runtime-checked)
- The route is always mounted so the server can return a meaningful 503 with an error message rather than a confusing 404

### Negative

- Tiny per-request overhead reading config (mitigated: configManager uses in-memory cache, no disk I/O)
- Route handlers are loaded in memory even when disabled (negligible: MCP server is created per-request anyway, not at startup)
