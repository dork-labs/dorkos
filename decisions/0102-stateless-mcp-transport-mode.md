---
number: 102
title: Stateless MCP Transport Mode
status: proposed
created: 2026-03-09
spec: mcp-server
superseded-by: null
---

# 102. Stateless MCP Transport Mode

## Status

Proposed

## Context

The MCP Streamable HTTP transport supports two modes: stateful (session IDs, SSE streams, session termination) and stateless (no session tracking, per-request transport). DorkOS MCP tools are pure request-response functions — no multi-step tool interactions, no server-initiated push, no conversation state within the MCP protocol itself. Stateful mode would add a session Map, TTL cleanup logic, and GET/DELETE endpoint handling with no functional benefit.

## Decision

Use stateless mode (`sessionIdGenerator: undefined`). Each POST request creates a fresh `NodeStreamableHTTPServerTransport`, connects it to the shared `McpServer` instance, and handles the request. GET and DELETE return 405 Method Not Allowed.

## Consequences

### Positive

- No session Map, no TTL cleanup, no memory growth over time
- Each request is fully independent — no state to leak or corrupt
- Simpler implementation and testing
- No risk of orphaned sessions consuming memory

### Negative

- Cannot support server-initiated push (notifications, progress updates) — if needed in the future, must migrate to stateful mode
- Cannot support MCP session resumability — each request starts fresh
- GET and DELETE endpoints return 405, which some MCP clients may not expect (though stateless mode is spec-compliant)
