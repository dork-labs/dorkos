---
number: 58
title: Use Dynamic CORS Callback for Tunnel Origin
status: archived
created: 2026-03-01
spec: tunnel-remote-access-overhaul
superseded-by: null
---

# 58. Use Dynamic CORS Callback for Tunnel Origin

## Status

Draft (auto-extracted from spec: tunnel-remote-access-overhaul)

## Context

The CORS configuration in `app.ts` uses a static allowlist built at startup, containing only localhost origins. When the ngrok tunnel connects after server startup, the tunnel URL is not in the allowlist. This causes all API requests from the tunnel origin to fail with CORS errors, making the tunnel feature non-functional in production.

## Decision

Replace the static `buildCorsOrigin()` return value with a dynamic CORS origin callback function. The callback checks `tunnelManager.status.url` at each request. When the tunnel is connected, the tunnel origin is dynamically added to the allowed list. When disconnected, only localhost origins are allowed. The `DORKOS_CORS_ORIGIN` env var override and wildcard (`*`) behavior are preserved.

## Consequences

### Positive

- Tunnel CORS works automatically without user configuration
- No need to restart the server when the tunnel URL changes
- Secure: only the current tunnel URL is allowed, not any arbitrary origin
- Negligible per-request overhead (~0.01ms for array lookup)

### Negative

- Slightly more complex CORS logic (callback vs static array)
- Must ensure `tunnelManager` is imported without circular dependencies
