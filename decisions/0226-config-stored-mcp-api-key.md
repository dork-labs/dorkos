---
number: 226
title: Store MCP API Key in Config.json with Env Var Override
status: draft
created: 2026-04-05
spec: external-mcp-access
superseded-by: null
---

# 226. Store MCP API Key in Config.json with Env Var Override

## Status

Draft (auto-extracted from spec: external-mcp-access)

## Context

The external MCP server at `/mcp` needs API key authentication to protect tool access. The key was previously managed exclusively via the `MCP_API_KEY` environment variable, meaning users had to set it in their shell and restart the server. This prevented any UI-based key management and was inconsistent with how the tunnel subsystem already stores its `authtoken` in `config.json`.

## Decision

Store the MCP API key in `~/.dork/config.json` under `mcp.apiKey`, with the `MCP_API_KEY` environment variable as an override. The auth middleware reads `env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey`. Add `'mcp.apiKey'` to `SENSITIVE_CONFIG_KEYS`. Provide a `POST /api/config/mcp/generate-key` endpoint for key generation with a `dork_` prefix.

## Consequences

### Positive

- Users can generate, view (masked), copy, and rotate API keys directly from the Settings UI
- No server restart required for key changes (configManager is in-memory cached)
- Consistent with the tunnel auth pattern already in production
- Env var override preserves deployment-time secrets management for advanced users

### Negative

- API key stored in plaintext in `~/.dork/config.json` (mitigated: local-only server, `0600` file permissions via conf package, same risk profile as existing tunnel authtoken)
