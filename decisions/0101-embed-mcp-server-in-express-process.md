---
number: 101
title: Embed MCP Server in Express Process
status: draft
created: 2026-03-09
spec: mcp-server
superseded-by: null
---

# 101. Embed MCP Server in Express Process

## Status

Draft (auto-extracted from spec: mcp-server)

## Context

DorkOS needs to expose its 28 MCP tools to external agents (Claude Code, Cursor, Windsurf, custom Agent SDK apps). Four approaches were evaluated: (1) embed Streamable HTTP transport in the existing Express process, (2) legacy HTTP+SSE transport, (3) stdio transport via separate script, (4) standalone MCP server on a separate port. DorkOS tools are implemented as pure async functions with dependency injection via `McpToolDeps`, and all service singletons (relay, mesh, pulse) live in the Express process memory.

## Decision

Embed the MCP server directly in the existing Express process using `@modelcontextprotocol/sdk`'s `McpServer` + `NodeStreamableHTTPServerTransport`, mounted at `/mcp` on the existing Express app. No new process, no new port.

## Consequences

### Positive

- Zero process management overhead — same lifecycle as Express server
- Direct access to all live service singletons without IPC
- Single port — works through existing ngrok tunnel
- Tool handler functions shared between internal (Claude Agent SDK) and external (MCP SDK) paths
- Lowest implementation complexity (3 route handlers + 1 factory + 1 middleware)

### Negative

- Server restart clears any MCP client connections (clients must re-initialize, which they handle automatically)
- Two tool registration APIs to maintain (Claude Agent SDK internally, MCP SDK externally) — handler functions shared but registration wrappers differ
- MCP traffic shares Express thread with REST API and SSE streams
