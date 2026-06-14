---
number: 205
title: MCP-Only Interface for Agent Extension Management
status: draft
created: 2026-03-26
spec: ext-platform-04-agent-extensions
superseded-by: null
---

# 0205. MCP-Only Interface for Agent Extension Management

## Status

Draft (auto-extracted from spec: ext-platform-04-agent-extensions)

## Context

Phase 4 adds 6 tools for agents to manage extensions (list, create, reload, errors, API reference, test). These tools could be exposed as HTTP REST endpoints (like existing extension routes), as MCP tools on the existing DorkOS MCP server, or both.

The DorkOS MCP server at `/mcp` already exposes tools for other agent-facing operations (session management, relay, mesh, agent management). External agents (Claude Code, Cursor, Windsurf) connect via MCP's Streamable HTTP transport.

## Decision

Expose extension management exclusively via MCP tools. No new HTTP REST endpoints for agent use. The existing REST routes (`/api/extensions/*`) remain for the DorkOS client UI, but agents use only the MCP interface.

## Consequences

### Positive

- Consistent agent-facing API — all agent operations go through MCP, not a mix of MCP and REST
- Authentication handled uniformly via MCP API key (`MCP_API_KEY`), not per-endpoint auth
- Tool descriptions and parameter schemas are self-documenting — agents discover capabilities via MCP protocol
- Follows the existing pattern established by other DorkOS tool domains (relay, mesh, pulse, agent management)

### Negative

- Agents that don't support MCP cannot manage extensions (mitigated: all major agents support MCP)
- MCP tool responses are text-only (JSON stringified) — no binary or streaming responses
- Debugging requires MCP-aware tools rather than simple `curl` commands
- If a future GUI admin tool needs extension management, it must use the REST routes (already available) or add new ones
