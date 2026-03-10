---
number: 103
title: Optional API Key Authentication for MCP
status: draft
created: 2026-03-09
spec: mcp-server
superseded-by: null
---

# 103. Optional API Key Authentication for MCP

## Status

Draft (auto-extracted from spec: mcp-server)

## Context

The MCP server endpoint at `/mcp` needs an authentication model. Three options were considered: (1) optional API key via environment variable, (2) always-require API key, (3) no auth at all. DorkOS is single-user and self-hosted, binding to localhost by default. When using ngrok tunnels, the endpoint becomes publicly reachable and needs protection. The MCP spec says auth is optional for localhost but recommended for non-localhost deployments.

## Decision

Use optional API key authentication via `MCP_API_KEY` environment variable. When set, enforce as Bearer token (`Authorization: Bearer <key>`) on every `/mcp` request. When unset, all requests pass through (localhost-only access). Auth is enforced per-request, not just at initialization — the `Mcp-Session-Id` header is routing-only, not auth.

## Consequences

### Positive

- Zero friction for local development (no key needed when bound to localhost)
- Simple security model that fits single-user self-hosted deployment
- Auth enforced on every request prevents session hijacking
- Standard Bearer token scheme — supported by all MCP clients via `headers` config

### Negative

- No key rotation mechanism — changing the key requires restarting the server and updating all client configs
- No per-client auth — all external agents share the same key
- If the user forgets to set `MCP_API_KEY` when using ngrok, the endpoint is open to the internet
