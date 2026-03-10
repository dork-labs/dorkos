---
slug: mcp-server
number: 107
created: 2026-03-09
status: ideation
---

# MCP Server — Expose DorkOS Tools to External Agents

**Slug:** mcp-server
**Author:** Claude Code
**Date:** 2026-03-09
**Branch:** preflight/mcp-server

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS currently injects MCP tools into its own agents via the Claude Agent SDK's in-process MCP server. We want to also run a standards-compliant MCP server so that any external agent — Claude Code, Cursor, Windsurf, custom Agent SDK apps — can connect over HTTP and use DorkOS capabilities (sessions, relay, mesh, pulse, adapters, bindings, traces) as MCP tools.
- **Assumptions:**
  - The existing 28 tool handlers are pure functions with dependency injection via `McpToolDeps` — they can be reused without modification
  - DorkOS is single-user, self-hosted — the auth model is simple (optional API key)
  - The MCP server will be embedded in the existing Express process (no new port, no new process)
  - `@modelcontextprotocol/sdk` is the official TypeScript SDK for building MCP servers
  - The Streamable HTTP transport is the current MCP spec standard (2025-03-26), replacing the deprecated HTTP+SSE pattern
- **Out of scope:**
  - Changing how internal agents consume tools (the `createSdkMcpServer()` / Claude Agent SDK path is unchanged)
  - OAuth 2.1 / PKCE authorization (the MCP spec defines this for multi-tenant hosted servers — not applicable to DorkOS's single-user model)
  - MCP Resources or Prompts (tools-only for v1)
  - Client-side MCP consumption (DorkOS is the server, not the client)

## 2) Pre-reading Log

- `specs/dynamic-mcp-tools/` (spec 41): Defines the current tool injection architecture — tools injected into SDK sessions via in-process MCP server using `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`
- `specs/agent-tool-context-injection/` (spec 88): Context blocks for tool usage documentation, injected into system prompt alongside tool definitions
- `contributing/architecture.md`: Hexagonal architecture with Transport interface, RuntimeRegistry for agent backend abstraction
- `contributing/api-reference.md`: OpenAPI docs, route mounting patterns
- `apps/server/src/index.ts`: Server startup orchestration — service initialization, route mounting with feature flag gating
- `apps/server/src/app.ts`: Express app creation, CORS, route mounting, OpenAPI docs
- `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts`: Composition root — `createDorkOsToolServer(deps)` assembles all 28 tools from 7 domain modules
- `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`: `McpToolDeps` interface — clean dependency injection for all tool handlers
- `apps/server/src/services/runtimes/claude-code/message-sender.ts`: `executeSdkQuery()` orchestrates tool filtering, context building, and SDK calls — shows how tools are currently consumed internally
- `apps/server/src/services/runtimes/claude-code/tool-filter.ts`: Per-agent tool filtering via `enabledToolGroups` manifest field
- `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts`: Tool approval flow — DorkOS MCP tools (`mcp__dorkos__*`) are currently auto-approved

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/runtimes/claude-code/mcp-tools/` — 7 tool group files defining 28 tools:
  - `core-tools.ts` (4 tools): ping, get_server_info, get_session_count, get_current_agent
  - `pulse-tools.ts` (5 tools): list/create/update/delete schedules, get run history
  - `relay-tools.ts` (7 tools): send, inbox, list/register/unregister endpoints, query, dispatch
  - `adapter-tools.ts` (4 tools): list/enable/disable/reload adapters
  - `binding-tools.ts` (3 tools): list/create/delete bindings
  - `trace-tools.ts` (2 tools): get trace, get metrics
  - `mesh-tools.ts` (8 tools): discover, register, list, deny, unregister, status, inspect, query topology
- `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts` — `McpToolDeps` interface (explicit DI)
- `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts` — `createDorkOsToolServer(deps)` composition root
- `apps/server/src/index.ts` — Server startup, service initialization, route mounting
- `apps/server/src/app.ts` — Express app creation
- `apps/server/src/routes/` — 14 route files following consistent factory pattern

**Shared Dependencies:**

- `McpToolDeps` — injected service references: transcriptReader, relayCore, meshCore, pulseStore, schedulerService, adapterManager, traceStore, bindingStore, configManager, etc.
- `@anthropic-ai/claude-agent-sdk` — `createSdkMcpServer()` for internal tool injection (existing)
- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport` for external MCP server (new dependency)
- Feature flag system: `lib/feature-flag.ts`, per-service state modules

**Data Flow (Current — Internal Tool Injection):**

```
User message → POST /api/sessions/:id/messages
  → ClaudeCodeRuntime.sendMessage()
    → executeSdkQuery()
      → createDorkOsToolServer(deps) injected as mcpServers: { dorkos: server }
      → SDK subprocess calls tool → handler invoked in-process → result returned
```

**Data Flow (New — External MCP Server):**

```
External agent → POST /mcp (JSON-RPC request)
  → StreamableHTTPServerTransport handles framing
    → McpServer routes to registered tool handler
      → Same handler functions from mcp-tools/ invoked with same McpToolDeps
    → JSON-RPC response returned
```

**Feature Flags/Config:**

| Feature | Flag | Default |
|---------|------|---------|
| MCP Server | None (always-on) | Enabled |
| API Key | `MCP_API_KEY` env var | Unset (open on localhost) |
| Relay tools | `relay.enabled` | true |
| Pulse tools | `scheduler.enabled` | true |
| Mesh tools | Always-on | true |

**Potential Blast Radius:**

- **Direct:** 3-4 new files (route, service factory, auth middleware, optional types)
- **Modified:** 2 files (`app.ts` for route mounting, `index.ts` for deps wiring)
- **Unchanged:** All 28 existing tool handlers, all service singletons
- **Tests:** 1-2 new test files (route handler tests, auth middleware tests)
- **Config:** New optional `MCP_API_KEY` env var in `env.ts`

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### MCP Protocol Overview

MCP is a JSON-RPC 2.0 protocol for connecting AI agents to external tools and resources. The 2025-03-26 specification defines two standard transports: **stdio** (local subprocess) and **Streamable HTTP** (remote, network-based). Streamable HTTP uses a single endpoint that handles POST (client→server messages), GET (server-initiated SSE streams), and DELETE (session termination). The older HTTP+SSE dual-endpoint transport is deprecated.

### Potential Solutions

**1. Streamable HTTP Transport — Embedded in Express (Recommended)**

- Description: Mount `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` on an Express router at `/mcp`. POST handler manages tool calls, GET handler opens SSE stream for server push, DELETE terminates sessions.
- Pros: No new process, no new port, direct access to all service singletons, works through existing ngrok tunnel, fully spec-compliant, supported by Claude Code/Cursor/Windsurf/Claude Desktop
- Cons: Two registration APIs (Claude Agent SDK internally, MCP SDK externally), handler functions shared but wrappers differ
- Complexity: Low (~3 route handlers + 1 service factory)
- Maintenance: Low (backed by official SDK)

**2. Legacy HTTP+SSE Transport**

- Description: Two endpoints — `GET /mcp` for SSE stream, `POST /mcp/messages` for requests
- Pros: Backward compat with pre-2025 clients
- Cons: Deprecated, security weaknesses (tokens in URL), complex session coupling
- Complexity: Medium
- Maintenance: High risk (deprecation path)

**3. Stdio Transport — Separate Script**

- Description: Separate `mcp-server.ts` entry point using stdin/stdout
- Pros: Process isolation, works with Claude Desktop's local mode
- Cons: No access to live Express singletons, requires second process, DorkOS services are in-memory singletons
- Complexity: Medium-High
- Maintenance: High (two processes to sync)

**4. Standalone MCP Server Process**

- Description: Dedicated HTTP server on a second port
- Pros: Process isolation, independent scaling
- Cons: Second port, second lifecycle, all service access requires IPC or shared DB
- Complexity: High
- Maintenance: High

### Security Considerations

- **Origin header validation** — hard MCP spec requirement (DNS rebinding protection)
- **Bind to `127.0.0.1`** — already the default; ngrok tunnel provides secure external path
- **API key enforcement** — optional `MCP_API_KEY` env var; when set, all `/mcp` requests must include it as Bearer token; enforced on every request, not just initialization
- **Session ID is not auth** — the `Mcp-Session-Id` header is routing-only

### Performance Considerations

- **In-process tool calls ≈ 0ms latency** — direct function calls into service singletons
- **Session map unnecessary** — stateless mode (`sessionIdGenerator: undefined`) eliminates session management entirely since DorkOS tools are pure request-response
- **Long-running tools** (e.g., `relay_query` with 120s timeout) — need to verify `StreamableHTTPServerTransport` holds the connection open

### Recommendation

**Streamable HTTP embedded in Express, stateless mode.** Minimal surface area, reuses all existing tool handlers, no new processes or ports. The `@modelcontextprotocol/sdk` is specifically designed for this embedding pattern.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Tool scope | All 28 tools | External agents get the same capabilities as internal agents. Tool filtering can be done client-side via MCP config. Avoids maintaining a separate allowlist. |
| 2 | Authentication | Optional API key via `MCP_API_KEY` env var | When set, enforced as Bearer token on all `/mcp` requests. When unset, open on localhost. Fits the single-user self-hosted model without adding friction for local development. |
| 3 | Session mode | Stateless (`sessionIdGenerator: undefined`) | DorkOS tools are pure request-response — no multi-step tool interactions. Eliminates session map, TTL cleanup, and state management entirely. |
| 4 | Feature flag | Always-on (no flag) | MCP server is a core capability for an agent coordination platform. Like Mesh, it should be unconditionally available. Follows the "DorkOS is for agents" thesis. |
