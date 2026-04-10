# Task Breakdown: MCP Server -- Expose DorkOS Tools to External Agents

Generated: 2026-03-09
Source: specs/mcp-server/02-specification.md
Last Decompose: 2026-03-09

## Overview

Embed a standards-compliant MCP server in the existing DorkOS Express process at `/mcp` using Streamable HTTP transport. External agents (Claude Code, Cursor, Windsurf, custom Agent SDK apps) can connect and use all DorkOS tools (sessions, relay, mesh, pulse, adapters, bindings, traces) as MCP tools. The server reuses existing tool handler functions via the `McpToolDeps` dependency injection interface, operates in stateless mode, and supports optional API key authentication.

## Phase 1: Foundation

### Task 1.1: Add @modelcontextprotocol/sdk dependency

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:

- Add `@modelcontextprotocol/sdk` to `apps/server/package.json` as a runtime dependency
- Verify `McpServer` and `NodeStreamableHTTPServerTransport` are importable from the installed package
- The SDK may export from subpackages -- check the installed version's `exports` field

**Implementation Steps**:

1. Add `"@modelcontextprotocol/sdk": "latest"` to `apps/server/package.json` `dependencies`
2. Run `pnpm install` from repo root
3. Verify import paths resolve

**Acceptance Criteria**:

- [ ] `@modelcontextprotocol/sdk` in `apps/server/package.json` dependencies
- [ ] `pnpm-lock.yaml` updated
- [ ] `McpServer` and `NodeStreamableHTTPServerTransport` importable
- [ ] `pnpm build` succeeds

---

### Task 1.2: Add MCP_API_KEY environment variable to env.ts and turbo.json

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Add `MCP_API_KEY: z.string().optional()` to `apps/server/src/env.ts` serverEnvSchema
- Add `MCP_API_KEY` to `turbo.json` `globalPassThroughEnv` in alphabetical order
- Add `MCP_API_KEY` entry to root `.env.example`

**Implementation Steps**:

1. Modify `apps/server/src/env.ts` -- add `MCP_API_KEY` to the Zod schema
2. Modify `turbo.json` -- insert `MCP_API_KEY` between `DORKOS_VERSION` and `NGROK_AUTHTOKEN`
3. Add commented entry to `.env.example` with usage guidance

**Acceptance Criteria**:

- [ ] `env.MCP_API_KEY` accessible as `string | undefined` in server code
- [ ] `MCP_API_KEY` in `turbo.json` `globalPassThroughEnv` in alphabetical order
- [ ] `.env.example` documents `MCP_API_KEY` with usage guidance
- [ ] Server starts without errors when `MCP_API_KEY` is not set
- [ ] `pnpm typecheck` passes

---

### Task 1.3: Create API key auth middleware for MCP endpoint

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:

- Create `apps/server/src/middleware/mcp-auth.ts`
- When `MCP_API_KEY` is unset, all requests pass through
- When set, validate `Authorization: Bearer <key>` on every request
- Return JSON-RPC formatted 401 errors (not REST)

**Implementation Steps**:

1. Create middleware file with `mcpApiKeyAuth` function
2. Check `env.MCP_API_KEY` -- if undefined, call `next()` immediately
3. Parse `Authorization` header for `Bearer <token>` scheme
4. Compare token to `MCP_API_KEY` -- call `next()` on match, return 401 JSON-RPC error otherwise

**Acceptance Criteria**:

- [ ] File exists at `apps/server/src/middleware/mcp-auth.ts`
- [ ] `mcpApiKeyAuth` exported
- [ ] Auth disabled when `MCP_API_KEY` unset
- [ ] Valid Bearer token passes through
- [ ] Invalid/missing auth returns 401 with JSON-RPC error body
- [ ] TSDoc on exported function

---

## Phase 2: Core Implementation

### Task 2.1: Create MCP server factory with all tool registrations

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Create `apps/server/src/services/core/mcp-server.ts`
- Factory function `createExternalMcpServer(deps: McpToolDeps): McpServer`
- Register all tools using `@modelcontextprotocol/sdk` `server.tool()` API
- All tools always registered (feature guards in handlers return errors when disabled)
- Tool names, descriptions, and Zod schemas match the internal `createDorkOsToolServer` path exactly
- Import and reuse all handler functions from existing tool modules

**Implementation Steps**:

1. Create factory file
2. Import `McpServer` from SDK
3. Import all handler creators from existing tool modules
4. Create McpServer instance with `{ name: 'dorkos', version: '1.0.0' }`
5. Register all tools (core: 4, pulse: 5, relay: 7, adapter: 4, binding: 3, trace: 2, mesh: 8)
6. Return the server instance

**Tool groups and counts**:

| Group   | Count | Tools                                                                                                                                    |
| ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Core    | 4     | ping, get_server_info, get_session_count, get_agent                                                                                      |
| Pulse   | 5     | pulse_list_schedules, pulse_create_schedule, pulse_update_schedule, pulse_delete_schedule, pulse_get_run_history                         |
| Relay   | 7     | relay_send, relay_inbox, relay_list_endpoints, relay_register_endpoint, relay_send_and_wait, relay_send_async, relay_unregister_endpoint |
| Adapter | 4     | relay_list_adapters, relay_enable_adapter, relay_disable_adapter, relay_reload_adapters                                                  |
| Binding | 3     | binding_list, binding_create, binding_delete                                                                                             |
| Trace   | 2     | relay_get_trace, relay_get_metrics                                                                                                       |
| Mesh    | 8     | mesh_discover, mesh_register, mesh_list, mesh_deny, mesh_unregister, mesh_status, mesh_inspect, mesh_query_topology                      |

**Acceptance Criteria**:

- [ ] File exists at `apps/server/src/services/core/mcp-server.ts`
- [ ] `createExternalMcpServer(deps)` returns an `McpServer`
- [ ] All 33 tools registered
- [ ] Handler functions imported from existing modules (no logic duplication)
- [ ] TSDoc on exported function
- [ ] `pnpm typecheck` passes

---

### Task 2.2: Create MCP route handler with Streamable HTTP transport

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.3

**Technical Requirements**:

- Create `apps/server/src/routes/mcp.ts`
- Router factory `createMcpRouter(server: McpServer): Router`
- POST handler creates per-request `NodeStreamableHTTPServerTransport` (stateless)
- GET returns 405 with JSON-RPC error
- DELETE returns 405 with JSON-RPC error
- Error handling with JSON-RPC formatted responses

**Implementation Steps**:

1. Create router factory file
2. POST handler: create transport with `sessionIdGenerator: undefined`, connect to server, handle request
3. GET handler: return 405
4. DELETE handler: return 405
5. Wrap POST in try/catch for clean error responses

**Acceptance Criteria**:

- [ ] File exists at `apps/server/src/routes/mcp.ts`
- [ ] POST creates per-request stateless transport
- [ ] GET/DELETE return 405 with JSON-RPC errors
- [ ] Error handling catches transport errors
- [ ] `pnpm typecheck` passes

---

### Task 2.3: Create Origin validation middleware for DNS rebinding protection

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Create `apps/server/src/middleware/mcp-origin.ts`
- Validate `Origin` header against localhost origins + tunnel URL
- No Origin header = pass through (non-browser clients)
- Return JSON-RPC 403 for disallowed origins

**Implementation Steps**:

1. Create middleware file with `validateMcpOrigin` function
2. If no Origin header, call `next()` (non-browser client)
3. Build allowlist: `http://localhost:{port}`, `http://127.0.0.1:{port}`, tunnel origin (if active)
4. Check Origin against allowlist
5. Return 403 JSON-RPC error for disallowed origins

**Acceptance Criteria**:

- [ ] File exists at `apps/server/src/middleware/mcp-origin.ts`
- [ ] No Origin = pass through
- [ ] Localhost origins pass
- [ ] Tunnel origin passes when active
- [ ] Unknown origins get 403 JSON-RPC error
- [ ] TSDoc on exported function

---

## Phase 3: Integration & Wiring

### Task 3.1: Mount MCP endpoint in Express app and add startup logging

**Size**: Medium
**Priority**: High
**Dependencies**: Tasks 1.2, 1.3, 2.1, 2.2, 2.3
**Can run parallel with**: None

**Technical Requirements**:

- Modify `apps/server/src/index.ts` to wire the external MCP server
- Reuse existing `mcpToolDeps` object (already assembled at line 199-208)
- Mount at `/mcp` (not `/api/mcp` -- protocol endpoint, not REST API)
- Middleware chain: `validateMcpOrigin` -> `mcpApiKeyAuth` -> `mcpRouter`
- Log startup message indicating mount status and auth mode

**Implementation Steps**:

1. Add imports for `createExternalMcpServer`, `createMcpRouter`, `mcpApiKeyAuth`, `validateMcpOrigin`
2. After `const app = createApp()` and before Pulse routes mounting, create and mount MCP server
3. Log auth mode (none vs API key) at startup

**Insertion point**: After line 211 (`const app = createApp()`) and before line 214 (`if (pulseEnabled && pulseStore)`)

**Startup log messages**:

- Without API key: `[MCP] External MCP server mounted at /mcp (stateless, auth: none)`
- With API key: `[MCP] External MCP server mounted at /mcp (stateless, auth: API key)`

**Acceptance Criteria**:

- [ ] MCP server created with existing `mcpToolDeps`
- [ ] `/mcp` route mounted with origin + auth middleware
- [ ] Mounted before `finalizeApp(app)` call
- [ ] Startup log indicates auth mode
- [ ] Server starts without errors
- [ ] All existing tests pass

---

## Phase 4: Testing

### Task 4.1: Write unit tests for MCP API key auth middleware

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Tasks 4.2, 4.3, 4.4

**Test file**: `apps/server/src/middleware/__tests__/mcp-auth.test.ts`

**Test scenarios** (7 tests):

1. `MCP_API_KEY` unset: all requests pass through
2. `MCP_API_KEY` unset: requests with auth header still pass through
3. `MCP_API_KEY` set + valid Bearer token: next called
4. `MCP_API_KEY` set + no Authorization header: 401 JSON-RPC error
5. `MCP_API_KEY` set + wrong token: 401
6. `MCP_API_KEY` set + non-Bearer scheme: 401
7. `MCP_API_KEY` set + malformed Authorization header: 401

**Acceptance Criteria**:

- [ ] All 7 test cases pass
- [ ] Tests use `vi.mock` to control `env.MCP_API_KEY`
- [ ] Tests verify HTTP status and JSON-RPC error body

---

### Task 4.2: Write unit tests for MCP Origin validation middleware

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: Tasks 4.1, 4.3, 4.4

**Test file**: `apps/server/src/middleware/__tests__/mcp-origin.test.ts`

**Test scenarios** (7 tests):

1. No Origin header passes through
2. `http://localhost:{port}` passes through
3. `http://127.0.0.1:{port}` passes through
4. Tunnel origin passes when tunnel active
5. Unknown origin gets 403
6. Localhost with wrong port gets 403
7. Tunnel-like origin rejected when tunnel not active

**Acceptance Criteria**:

- [ ] All 7 test cases pass
- [ ] Tests mock `env` and `tunnelManager`
- [ ] Tests verify status code and JSON-RPC error body

---

### Task 4.3: Write unit tests for MCP server factory

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Tasks 4.1, 4.2, 4.4

**Test file**: `apps/server/src/services/core/__tests__/mcp-server.test.ts`

**Test scenarios** (4 tests):

1. Factory creates a valid McpServer instance
2. Server created successfully (tools registered without error)
3. Server works with full deps (all optional services)
4. Server works with minimal deps (only required fields)

**Acceptance Criteria**:

- [ ] All 4 test cases pass
- [ ] Factory does not throw with minimal or full deps
- [ ] Mocks env and manifest reader

---

### Task 4.4: Write unit tests for MCP route handler

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: Tasks 4.1, 4.2, 4.3

**Test file**: `apps/server/src/routes/__tests__/mcp.test.ts`

**Test scenarios** (4 tests):

1. GET returns 405 with JSON-RPC error
2. DELETE returns 405 with JSON-RPC error
3. POST creates transport with stateless config
4. POST connects transport to server

**Acceptance Criteria**:

- [ ] All 4 test cases pass
- [ ] Uses supertest for HTTP-level testing
- [ ] Mocks MCP SDK transport

---

### Task 4.5: Write integration test for MCP endpoint JSON-RPC round-trip

**Size**: Medium
**Priority**: Medium
**Dependencies**: Tasks 2.1, 2.2, 3.1
**Can run parallel with**: None

**Test file**: `apps/server/src/routes/__tests__/mcp-integration.test.ts`

**Test scenarios**:

1. Initialize request returns 200
2. Full round-trip with real McpServer and transport

**Acceptance Criteria**:

- [ ] Uses real McpServer (not mocked)
- [ ] Sends actual JSON-RPC requests via supertest
- [ ] Initialize request returns 200

---

## Phase 5: Documentation

### Task 5.1: Add MCP Server section to API reference and update AGENTS.md

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Implementation Steps**:

1. Add "MCP Server" section to `contributing/api-reference.md` with endpoint docs, auth info, client config examples
2. Add brief `/mcp` mention to `AGENTS.md` server architecture section

**Acceptance Criteria**:

- [ ] `contributing/api-reference.md` has MCP Server section
- [ ] `AGENTS.md` mentions `/mcp` endpoint
- [ ] Client config examples for Claude Code, Cursor/Windsurf, and ngrok tunnel

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1  Add SDK dependency
  1.2  Add MCP_API_KEY env var
  1.3  Create auth middleware

Phase 2 (depends on 1.1):
  2.1  Create MCP server factory    [depends: 1.1]
  2.2  Create route handler          [depends: 1.1, parallel with 2.3]
  2.3  Create origin middleware      [no deps, parallel with 2.2]

Phase 3 (depends on all P1+P2):
  3.1  Mount in Express app          [depends: 1.2, 1.3, 2.1, 2.2, 2.3]

Phase 4 (testing, mostly parallel):
  4.1  Auth middleware tests          [depends: 1.3]
  4.2  Origin middleware tests        [depends: 2.3]
  4.3  Server factory tests           [depends: 2.1]
  4.4  Route handler tests            [depends: 2.2]
  4.5  Integration test               [depends: 2.1, 2.2, 3.1]

Phase 5 (docs):
  5.1  API reference + AGENTS.md      [depends: 3.1]
```

## Critical Path

1.1 -> 2.1 -> 3.1 -> 4.5 -> 5.1

## Summary

| Phase                         | Count  | Description                                      |
| ----------------------------- | ------ | ------------------------------------------------ |
| Phase 1: Foundation           | 3      | SDK dep, env var, auth middleware                |
| Phase 2: Core Implementation  | 3      | Server factory, route handler, origin middleware |
| Phase 3: Integration & Wiring | 1      | Mount in Express app                             |
| Phase 4: Testing              | 5      | Unit tests + integration test                    |
| Phase 5: Documentation        | 1      | API reference + AGENTS.md                        |
| **Total**                     | **13** |                                                  |
