---
slug: dynamic-mcp-tools
number: 41
created: 2026-02-17
status: ideation
---

# Dynamic MCP Tool Injection Architecture

**Slug:** dynamic-mcp-tools
**Author:** Claude Code
**Date:** 2026-02-17
**Related:** [Scheduler research](../../research/scheduler-comparison.md), [SDK capabilities research](../../research/claude-code-sdk-agent-capabilities.md), [MCP injection patterns](../../research/mcp-tool-injection-patterns.md)

---

## 1) Intent & Assumptions

- **Task brief:** Create the server-side architecture to dynamically inject MCP tools into Claude Code SDK `query()` calls from `AgentManager`. Build a proof-of-concept tool that validates all patterns needed for future features (scheduler management, session introspection, config access). This is the foundational plumbing that makes the agent _aware_ of DorkOS.
- **Assumptions:**
  - We modify `AgentManager.sendMessage()` to pass `mcpServers` to the SDK
  - The PoC tool exercises: Zod schema validation, async handler, server-internal access, verifiable output
  - MCP tools are registered once at startup (static registration), not per-session
  - We do NOT build UI changes, scheduler, or CLI subcommands in this scope
  - The `prompt` parameter must change from `string` to `AsyncIterable<SDKUserMessage>` (SDK constraint for in-process MCP servers)
- **Out of scope:**
  - Client UI for MCP tool management or visibility
  - Scheduler implementation (future feature that consumes this plumbing)
  - System prompt modifications (planned for scheduler, not needed for PoC)
  - CLI subcommands for tool management
  - Per-session or per-user tool variation
  - External (stdio/HTTP/SSE) MCP server support (only in-process SDK servers for now)

---

## 2) Pre-reading Log

- `contributing/architecture.md`: Hexagonal architecture, Transport interface. Services are singletons in flat `services/` directory. AgentManager is the sole SDK integration point.
- `contributing/api-reference.md`: Zod-first validation, OpenAPI auto-generation from schemas. Routes are thin handlers delegating to services.
- `apps/server/src/services/agent-manager.ts` (550 lines): Constructs `sdkOptions` and calls `query()`. Currently sets `cwd`, `includePartialMessages`, `settingSources`, `pathToClaudeCodeExecutable`, `resume`, `permissionMode`, `model`, `canUseTool`. Does NOT set `mcpServers`, `systemPrompt`, `allowedTools`, `hooks`, or `agents`.
- `apps/server/src/services/interactive-handlers.ts` (106 lines): `canUseTool` callback routes `AskUserQuestion` and tool approval. MCP tool calls (`mcp__*` names) will hit this same callback — no changes needed.
- `apps/server/src/routes/sessions.ts` (300 lines): Thin route handlers. `POST /messages` calls `agentManager.sendMessage()` and streams SSE. No changes needed.
- `apps/server/src/index.ts`: Server startup, singleton initialization. This is where we'll wire up the MCP tool server.
- `apps/server/src/services/config-manager.ts` (146 lines): Singleton pattern with `initConfigManager()`. Good reference for the `setMcpServers()` pattern.
- `apps/server/src/config/constants.ts`: Constants pattern. No changes needed.
- `packages/shared/src/schemas.ts`: Zod schemas → types → OpenAPI. StreamEvent types include `tool_call_start/delta/end` which will handle MCP tool events without changes.
- `apps/server/src/services/__tests__/agent-manager.test.ts`: Mocks `@anthropic-ai/claude-agent-sdk` with `vi.mock()`. Uses `vi.resetModules()` + dynamic import in `beforeEach`. Pattern for our new tests.
- `research/claude-code-sdk-agent-capabilities.md`: Full SDK Options reference. Confirms `mcpServers`, `createSdkMcpServer`, `tool` are all available.
- `research/mcp-tool-injection-patterns.md`: Deep analysis of SDK constraints, architecture options, and PoC tool design.

---

## 3) Codebase Map

### Primary Components

| File                                               | Role                                                    | Lines |
| -------------------------------------------------- | ------------------------------------------------------- | ----- |
| `apps/server/src/services/agent-manager.ts`        | SDK orchestration — the ONLY place that calls `query()` | 550   |
| `apps/server/src/services/interactive-handlers.ts` | Tool approval + question flows via `canUseTool`         | 106   |
| `apps/server/src/routes/sessions.ts`               | HTTP route handlers for messages, sessions              | 300   |
| `apps/server/src/index.ts`                         | Server startup, singleton wiring                        | ~80   |
| `packages/shared/src/schemas.ts`                   | Zod schemas for all shared types                        | ~300  |

### Shared Dependencies

- `@anthropic-ai/claude-agent-sdk`: `query`, `Options`, `createSdkMcpServer`, `tool`, `SDKMessage`, `PermissionResult`
- `zod`: Input validation for tool schemas
- `@dorkos/shared/types`: `StreamEvent`, `PermissionMode`
- `apps/server/src/lib/logger.ts`: Structured logging
- `apps/server/src/lib/boundary.ts`: Directory validation

### Data Flow (Current)

```
User message (string)
  → POST /api/sessions/:id/messages
  → agentManager.sendMessage(sessionId, content, { cwd })
  → sdkOptions = { cwd, includePartialMessages, settingSources, permissionMode, canUseTool, ... }
  → query({ prompt: content, options: sdkOptions })
  → SDK subprocess runs, yields SDKMessage stream
  → mapSdkMessage() → StreamEvent generator
  → SSE response to client
```

### Data Flow (With MCP Tools)

```
User message (string)
  → POST /api/sessions/:id/messages
  → agentManager.sendMessage(sessionId, content, { cwd })
  → sdkOptions = { ...existing, mcpServers: { 'dorkos': mcpToolServer } }
  → prompt wrapped as AsyncIterable<SDKUserMessage>     ← NEW
  → query({ prompt: makeUserPrompt(content), options: sdkOptions })
  → SDK subprocess runs WITH MCP tools available
  → Agent can call mcp__dorkos__ping, mcp__dorkos__get_server_info
  → Tool calls flow through existing tool_call_start/delta/end events
  → canUseTool callback fires for MCP tools (existing approval flow)
  → mapSdkMessage() → StreamEvent generator (no changes needed)
  → SSE response to client
```

### Potential Blast Radius

**Direct changes (MUST change):**

1. `apps/server/src/services/agent-manager.ts` — Add `setMcpServers()`, convert prompt to AsyncIterable
2. `apps/server/src/services/mcp-tool-server.ts` — **NEW FILE** — PoC tool definitions
3. `apps/server/src/index.ts` — Wire up MCP tool server at startup
4. `apps/server/src/services/__tests__/mcp-tool-server.test.ts` — **NEW FILE** — Tool handler unit tests

**Indirectly affected (VERIFY, no changes expected):**

- `routes/sessions.ts` — Generic handler, will auto-work
- `interactive-handlers.ts` — `canUseTool` handles `mcp__*` names transparently
- Client layer — Receives same `StreamEvent` types, tool_call rendering is generic
- `apps/obsidian-plugin/` — Uses `DirectTransport` which delegates to `AgentManager`

**Service count after:** 17 files (from 16). Within the advisory range, no domain grouping needed.

---

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

---

## 5) Research

### Architecture Options Evaluated

**Option A: Single MCP server with all DorkOS tools (RECOMMENDED for PoC)**

One `createSdkMcpServer()` call produces a server named `dorkos` with all tools. Passed to every `query()` call.

- **Pros:** Simple to manage, single `allowedTools` wildcard, easy to test as a unit, all tools discoverable in one place
- **Cons:** Tools from unrelated domains share namespace, cannot enable/disable feature groups independently
- **Complexity:** Low
- **Verdict:** Start here. Migrate to multi-server when tool count exceeds 10.

**Option B: Multiple MCP servers (one per feature domain)**

Separate servers: `dorkos-session`, `dorkos-scheduler`, `dorkos-config`.

- **Pros:** Clean domain separation, can enable/disable entire domains, files stay small
- **Cons:** More composition complexity, verbose tool names, registry/factory pattern needed
- **Complexity:** Medium
- **Verdict:** Better at scale. Not needed for 2-3 PoC tools.

**Option C: Static registration at startup (RECOMMENDED)**

MCP server created once at startup, injected into `AgentManager` instance. Dependencies (services) captured in closures.

- **Pros:** Zero per-request cost, consistent availability, simple to reason about
- **Cons:** Cannot vary per session
- **Complexity:** Low
- **Verdict:** Correct for DorkOS. All services are singletons.

**Option D: Dynamic composition per session**

Build MCP servers per `sendMessage()` call based on session context.

- **Pros:** Session-specific tool availability
- **Cons:** `createSdkMcpServer()` called per request (unclear if safe), potential instance leaks, complex
- **Complexity:** High
- **Verdict:** Avoid. Use static registration with session context via closures.

### SDK Constraints Discovered

| Constraint                                                       | Impact                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **`prompt` must be `AsyncIterable` when `mcpServers` is set**    | Must wrap string prompt in generator. Safe to apply unconditionally.         |
| Tool names follow `mcp__{server}__{tool}` pattern                | PoC tools will appear as `mcp__dorkos__ping`, `mcp__dorkos__get_server_info` |
| `canUseTool` fires for MCP tools                                 | Existing approval flow works unchanged                                       |
| `resume` compatible with `mcpServers`                            | Session continuity preserved                                                 |
| SDK MCP servers must be re-injected on each `query()` call       | Static field on AgentManager, passed every time                              |
| Tool handler errors should return `{ isError: true }`, not throw | Wrap handlers in try/catch                                                   |
| `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` default is 60s                | Set env var if tools take >60s (not needed for PoC)                          |

### PoC Tool Design

**Tool 1: `ping`** (validates basic plumbing)

- Zero input schema (validates empty Zod object works)
- Synchronous handler
- Returns `{ status: "pong", timestamp: "...", server: "dorkos" }`
- Agent will use it when asked "can you ping the server?"

**Tool 2: `get_server_info`** (validates Zod input, async handler, service access)

- Zod schema with optional boolean field
- Accesses `process.uptime()`, `process.env.DORKOS_PORT`, server version
- Returns structured JSON
- Validates that the agent can discover and use tools with typed inputs

### Security Considerations

- Tool handlers run in-process — infinite loops or panics block the agent turn. Wrap in try/catch.
- Tool inputs are model-generated — Zod validation provides defense in depth.
- In `default` permission mode, users must approve MCP tool calls via the existing DorkOS approval UI. This is correct behavior.
- Do not expose dangerous service internals (arbitrary SQL, shell commands) via MCP tools.

### Performance Considerations

- `createSdkMcpServer()` should be called once at startup, not per-request.
- The `AsyncIterable` prompt form has negligible overhead vs plain string.
- With 2-5 tools, MCP tool search (`ENABLE_TOOL_SEARCH`) will not activate (threshold is 10% of context window).

---

## 6) Clarifications

1. **Should MCP tools require approval in `default` permission mode?**
   - Current behavior: `canUseTool` fires → approval prompt shown
   - Recommendation: Yes, keep existing behavior. Users should see and approve custom tool calls.
   - Alternative: Auto-allow `mcp__dorkos__*` tools since they're our own — would bypass the approval UI for internal tools

2. **Should we always use the `AsyncIterable` prompt form, or only when MCP servers are present?**
   - Recommendation: Always use it. It's backward-compatible and avoids conditional logic.
   - Alternative: Conditionally wrap only when `Object.keys(mcpServers).length > 0`

3. **Should the PoC include a tool that accesses a real service (e.g., `TranscriptReader`)?**
   - Recommendation: Yes — `get_server_info` should access at least `process.uptime()` and env vars. A third tool like `get_session_count` could demonstrate service dependency injection.
   - This would validate the dependency injection pattern needed for scheduler tools.

4. **File placement: `services/mcp-tool-server.ts` or `services/mcp/tool-server.ts`?**
   - Current convention: flat `services/` directory (16 files, below domain-grouping threshold)
   - Recommendation: `services/mcp-tool-server.ts` (flat, consistent with current structure)
   - When we add scheduler tools, config tools, etc., we can refactor to `services/mcp/` subdirectory
