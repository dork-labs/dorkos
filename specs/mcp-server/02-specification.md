---
slug: mcp-server
number: 107
title: 'MCP Server — Expose DorkOS Tools to External Agents'
created: 2026-03-09
status: draft
authors: ['Claude Code']
ideation: specs/mcp-server/01-ideation.md
research: research/20260309_mcp_server_express_embedding.md
---

# MCP Server — Expose DorkOS Tools to External Agents

## Status

Draft

## Overview

Embed a standards-compliant MCP server in the existing DorkOS Express process so that any external agent — Claude Code, Cursor, Windsurf, custom Agent SDK apps — can connect over Streamable HTTP and use DorkOS capabilities (sessions, relay, mesh, pulse, adapters, bindings, traces) as MCP tools.

The MCP server mounts at `/mcp` on the existing Express app, reuses all 28 existing tool handlers via the `McpToolDeps` dependency injection interface, and requires no new process or port. Authentication is an optional API key. Session mode is stateless.

## Background / Problem Statement

DorkOS is an agent coordination platform. Its tools (relay messaging, mesh discovery, pulse scheduling, adapter management, binding configuration, trace inspection) are currently only accessible to agents spawned internally via the Claude Agent SDK's in-process MCP server (`createSdkMcpServer()`). External agents — Claude Code sessions, Cursor, Windsurf, custom Agent SDK apps — cannot access these capabilities.

The Model Context Protocol (MCP) is the industry standard for connecting AI agents to external tools. DorkOS already speaks MCP internally; making it available externally over HTTP is the natural next step. This enables:

- A Claude Code session to query relay messages, inspect mesh topology, or create pulse schedules
- A Cursor/Windsurf agent to discover peer agents and send relay messages
- Custom Agent SDK apps to use DorkOS as a coordination backend

## Goals

- Expose all 28 existing DorkOS MCP tools to external agents via Streamable HTTP
- Reuse existing tool handler functions without modification
- Embed in the existing Express process (no new port, no new process)
- Provide optional API key authentication for tunnel/remote scenarios
- Follow the MCP 2025-03-26 specification for Streamable HTTP transport
- Support stateless operation (no session tracking)

## Non-Goals

- Changing how internal agents consume tools (the `createSdkMcpServer()` / Claude Agent SDK path is unchanged)
- OAuth 2.1 / PKCE authorization (for multi-tenant hosted servers — not applicable to DorkOS's single-user model)
- MCP Resources or Prompts (tools-only for v1)
- Client-side MCP consumption (DorkOS is the server, not the client)
- Legacy HTTP+SSE transport (deprecated in 2025-03-26 spec)
- Stdio transport (requires a separate process, loses access to live singletons)
- Tool filtering per external connection (client-side filtering via MCP config is sufficient)

## Technical Dependencies

| Dependency                  | Version  | Purpose                                                                 |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | latest   | `McpServer`, `NodeStreamableHTTPServerTransport`, `isInitializeRequest` |
| `zod`                       | existing | Tool input schemas (already in project)                                 |
| `express`                   | existing | Route mounting                                                          |

**Import paths** (from `@modelcontextprotocol/sdk`):

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/node.js';
```

> **Note:** The SDK may export these from subpackages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`). Use whichever import paths the installed version supports. The architecture is the same regardless.

## Detailed Design

### Architecture

```
                          DorkOS Express Server (DORKOS_PORT)
                          ┌───────────────────────────────────┐
                          │                                   │
  External Agent ────────►│  POST /mcp  ──► MCP Route Handler │
  (Claude Code,           │                    │              │
   Cursor, etc.)          │              API Key Auth?        │
                          │                    │              │
                          │              StreamableHTTP       │
                          │              Transport            │
                          │                    │              │
                          │              McpServer            │
                          │              (28 tools)           │
                          │                    │              │
                          │         ┌──────────┼──────────┐   │
                          │         ▼          ▼          ▼   │
                          │      RelayCore  MeshCore  Pulse   │
                          │      (singletons shared with      │
                          │       internal agent path)        │
                          └───────────────────────────────────┘
```

**Data flow:**

1. External agent sends `POST /mcp` with JSON-RPC request body
2. Optional API key middleware validates `Authorization: Bearer <key>` (if `MCP_API_KEY` is set)
3. Route handler creates a per-request `NodeStreamableHTTPServerTransport` (stateless)
4. Transport connects to the shared `McpServer` instance (tools registered once at startup)
5. Transport handles the request, invoking the matching tool handler
6. Tool handler (same function as internal path) executes against live service singletons
7. JSON-RPC response returned

### File Changes

| File                                          | Change     | Description                                                  |
| --------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `apps/server/src/services/core/mcp-server.ts` | **New**    | Factory: creates `McpServer` with all 28 tools registered    |
| `apps/server/src/routes/mcp.ts`               | **New**    | Express router: POST/GET/DELETE handlers for Streamable HTTP |
| `apps/server/src/middleware/mcp-auth.ts`      | **New**    | API key auth middleware for `/mcp` route                     |
| `apps/server/src/app.ts`                      | **Modify** | Mount `/mcp` router before `finalizeApp()`                   |
| `apps/server/src/index.ts`                    | **Modify** | Create external MCP server, pass to route factory            |
| `apps/server/src/env.ts`                      | **Modify** | Add `MCP_API_KEY` optional env var                           |
| `apps/server/package.json`                    | **Modify** | Add `@modelcontextprotocol/sdk` dependency                   |
| `turbo.json`                                  | **Modify** | Add `MCP_API_KEY` to `globalPassThroughEnv`                  |

### 1. MCP Server Factory (`services/core/mcp-server.ts`)

Creates a single `McpServer` instance with all 28 DorkOS tools registered using the `@modelcontextprotocol/sdk` API. This is the external counterpart to `createDorkOsToolServer()` (which uses the Claude Agent SDK).

**Key design decisions:**

- **Single instance, per-request transport.** Unlike the internal path (which creates a new server per SDK `query()` call due to Claude Agent SDK's one-transport-per-Protocol limitation), the MCP SDK's `McpServer` supports multiple `connect()` calls. A single server instance is created at startup with all tools registered, and each request creates a fresh transport that connects to it.
- **Tool metadata duplication is intentional.** The MCP SDK's `server.tool()` API differs from the Claude Agent SDK's `tool()` function. Tool handler functions are shared; only the registration wrapper differs. This duplication is acceptable because the two SDKs serve different contexts (internal injection vs. external HTTP).

**Tool registration pattern:**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpToolDeps } from '../runtimes/claude-code/mcp-tools/types.js';
import {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler /* ... */,
} from '../runtimes/claude-code/mcp-tools/index.js';

export function createExternalMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({
    name: 'dorkos',
    version: '1.0.0',
  });

  // Core tools
  server.tool(
    'ping',
    'Check that the DorkOS server is running. Returns pong with a timestamp.',
    {},
    handlePing
  );
  server.tool(
    'get_server_info',
    'Returns DorkOS server metadata.',
    {
      include_uptime: z.boolean().optional().describe('Include server uptime in seconds'),
    },
    handleGetServerInfo
  );

  const handleGetSessionCount = createGetSessionCountHandler(deps);
  server.tool(
    'get_session_count',
    'Returns the number of active sessions.',
    {},
    handleGetSessionCount
  );

  // ... remaining 25 tools follow the same pattern
  // Each tool group (pulse, relay, adapter, binding, trace, mesh) is registered
  // with the same handler functions and Zod schemas as the internal path.

  return server;
}
```

**Handler compatibility:** Tool handlers return `{ content: [{ type: 'text', text: string }], isError?: boolean }`. This format is compatible with both SDKs. No adapter or transformation needed.

**Feature-guarded tools:** Tools for optional features (Pulse, Relay, Adapters, Bindings, Traces) are always registered. Their handlers already include `requirePulse(deps)` / `requireRelay(deps)` guards that return a descriptive error when the feature is disabled. This matches the behavior of the internal path.

### 2. Route Handler (`routes/mcp.ts`)

Express router factory that handles Streamable HTTP transport.

```typescript
import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/node.js';

export function createMcpRouter(server: McpServer): Router {
  const router = Router();

  // POST: JSON-RPC tool calls (primary endpoint)
  router.post('/', async (req, res) => {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET: Server-initiated SSE stream — not needed in stateless mode
  router.get('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This server operates in stateless mode.',
      },
      id: null,
    });
  });

  // DELETE: Session termination — not applicable in stateless mode
  router.delete('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This server operates in stateless mode.',
      },
      id: null,
    });
  });

  return router;
}
```

**JSON body parsing:** The DorkOS Express app already has `express.json({ limit: '1mb' })` middleware. The route passes `req.body` (pre-parsed) to `transport.handleRequest()` to avoid double-parsing.

**Error handling:** If `server.connect()` or `transport.handleRequest()` throws, the Express error handler middleware catches it. The route handler wraps the async call in a try/catch for clean JSON-RPC error responses.

### 3. Auth Middleware (`middleware/mcp-auth.ts`)

Optional API key authentication. When `MCP_API_KEY` is set, requires `Authorization: Bearer <key>` on every request. When unset, all requests pass through.

```typescript
import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';

export function mcpApiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = env.MCP_API_KEY;

  // No key configured — auth disabled (localhost-only access)
  if (!apiKey) {
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || token !== apiKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized. Set Authorization: Bearer <MCP_API_KEY>.' },
      id: null,
    });
    return;
  }

  next();
}
```

**Security properties:**

- Constant-time comparison is not strictly needed for a single-user self-hosted server, but if desired, use `crypto.timingSafeEqual()`.
- Auth is enforced on every request, not just initialization (session ID is not auth).
- The middleware is mounted on the `/mcp` route only — does not affect other API routes.

### 4. Environment Variable (`env.ts`)

Add `MCP_API_KEY` as an optional string:

```typescript
const serverEnvSchema = z.object({
  // ... existing vars ...
  MCP_API_KEY: z.string().optional(),
});
```

Also add `MCP_API_KEY` to `turbo.json` `globalPassThroughEnv` array so Turborepo passes it through to the server process.

### 5. App Mounting (`app.ts`)

The `/mcp` route mounts at the top level (not under `/api/`) because it is a protocol endpoint, not a REST API. The route is mounted in `app.ts` or `index.ts` after creating the app but before `finalizeApp()`.

The app creation function gains an optional parameter for the MCP router:

```typescript
// In index.ts, after creating the external MCP server:
const externalMcpServer = createExternalMcpServer(mcpToolDeps);
const mcpRouter = createMcpRouter(externalMcpServer);

const app = createApp();

// Mount MCP route — protocol endpoint, not REST API, so top-level /mcp
app.use('/mcp', mcpApiKeyAuth, mcpRouter);

// ... existing route mounting ...

finalizeApp(app);
```

**Mounting order:** The `/mcp` route can be mounted before or after `/api/*` routes since there is no path overlap. It must be mounted before `finalizeApp()` which adds the catch-all SPA handler.

### 6. Server Initialization (`index.ts`)

Wire the external MCP server into the startup sequence. The `mcpToolDeps` object (lines 199-208) is already assembled — reuse it.

```typescript
// After mcpToolDeps assembly (existing code) and before app.listen():
import { createExternalMcpServer } from './services/core/mcp-server.js';
import { createMcpRouter } from './routes/mcp.js';
import { mcpApiKeyAuth } from './middleware/mcp-auth.js';

const externalMcpServer = createExternalMcpServer(mcpToolDeps);
app.use('/mcp', mcpApiKeyAuth, createMcpRouter(externalMcpServer));
logger.info('[MCP] External MCP server mounted at /mcp');
```

### DNS Rebinding Protection

The MCP spec requires Origin header validation on Streamable HTTP endpoints to prevent DNS rebinding attacks. Two approaches:

**Option A: Use `@modelcontextprotocol/express` helper** — The SDK ships a `createMcpExpressApp()` function that creates an Express app with Origin validation built in. This can be used as a sub-app mounted on the DorkOS Express app. However, this introduces a third package dependency and creates a nested Express app.

**Option B: Manual Origin validation middleware** — Add a middleware to the `/mcp` route that validates the `Origin` header against the allowlist (localhost origins + tunnel URL). This is consistent with how DorkOS already handles CORS.

**Recommendation:** Option B (manual middleware). The validation logic is straightforward and DorkOS already has a dynamic CORS origin checker in `app.ts` that can be referenced. The middleware rejects requests from disallowed origins before they reach the transport handler.

```typescript
function validateMcpOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // No origin header — non-browser client (curl, Claude Code, etc.) — allow
  if (!origin) {
    next();
    return;
  }

  // Check against allowed origins (localhost + tunnel)
  const port = env.DORKOS_PORT;
  const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  // Add tunnel origin if active
  const tunnelUrl = tunnelManager.status.url;
  if (tunnelUrl) {
    allowed.push(new URL(tunnelUrl).origin);
  }

  if (!allowed.includes(origin)) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: `Origin ${origin} not allowed` },
      id: null,
    });
    return;
  }

  next();
}
```

**Middleware chain on `/mcp`:** `validateMcpOrigin` → `mcpApiKeyAuth` → `mcpRouter`

## User Experience

### External Client Configuration

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:4242/mcp"
    }
  }
}
```

With API key:

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:4242/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

**Cursor / Windsurf:** Add MCP server in settings with URL `http://localhost:4242/mcp` and type `http`.

**Via ngrok tunnel:**

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "https://your-tunnel.ngrok-free.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

### Server Startup Output

```
[MCP] External MCP server mounted at /mcp (28 tools, stateless)
```

When API key is configured:

```
[MCP] External MCP server mounted at /mcp (28 tools, stateless, auth: API key)
```

## Testing Strategy

### Unit Tests

**1. Auth middleware tests** (`middleware/__tests__/mcp-auth.test.ts`)

- When `MCP_API_KEY` is unset, all requests pass through
- When `MCP_API_KEY` is set, requests with valid Bearer token pass
- When `MCP_API_KEY` is set, requests with invalid token get 401
- When `MCP_API_KEY` is set, requests with no Authorization header get 401
- When `MCP_API_KEY` is set, requests with non-Bearer scheme get 401

**2. Origin validation tests** (`middleware/__tests__/mcp-origin.test.ts`)

- Requests with no Origin header pass through (non-browser clients)
- Requests from localhost origins pass
- Requests from unknown origins get 403
- Requests from tunnel origin pass (when tunnel is active)

**3. Route handler tests** (`routes/__tests__/mcp.test.ts`)

- POST with valid JSON-RPC initialize request returns success
- POST with valid tool call returns tool result
- GET returns 405
- DELETE returns 405
- POST with malformed JSON-RPC returns JSON-RPC error

**4. MCP server factory tests** (`services/core/__tests__/mcp-server.test.ts`)

- Factory creates McpServer with correct name and version
- All 28 tools are registered (verify tool count)
- Tool handlers are callable and return expected format
- Feature-guarded tools return descriptive errors when feature is disabled

### Integration Tests

- Start DorkOS server, send JSON-RPC `initialize` + `tools/list` via curl, verify all 28 tools listed
- Send JSON-RPC `tools/call` for `ping` tool, verify pong response
- Send JSON-RPC `tools/call` with API key when `MCP_API_KEY` is set

### Mocking Strategy

- Mock `McpToolDeps` services (transcriptReader, relayCore, etc.) using existing `@dorkos/test-utils` patterns
- Mock `env.MCP_API_KEY` via `vi.mock('../env.js')`
- Use supertest for HTTP-level route testing

## Performance Considerations

- **In-process tool calls are ~0ms latency.** Direct function calls into service singletons, no IPC.
- **Per-request transport creation is lightweight.** `NodeStreamableHTTPServerTransport` is a thin wrapper — construction cost is negligible compared to tool execution time.
- **Single McpServer instance.** Tool registration happens once at startup. No per-request registration overhead.
- **No session state.** No Map, no TTL cleanup, no memory growth over time. Each request is fully independent.
- **Long-running tools** (e.g., `relay_send_and_wait` with 120s timeout): The Streamable HTTP transport holds the HTTP connection open until the handler resolves. Express does not timeout the connection by default, so this works correctly.

## Security Considerations

1. **Origin header validation** — Hard MCP spec requirement. Prevents DNS rebinding attacks by rejecting requests from unknown browser origins. Non-browser clients (curl, Claude Code CLI) send no Origin header and pass through.
2. **Bind to localhost** — DorkOS Express server already binds to `localhost` by default. External access goes through ngrok tunnel (HTTPS transport security).
3. **API key on tunnel** — When ngrok is active, the MCP endpoint becomes publicly reachable. `MCP_API_KEY` should be set when using tunnel to prevent unauthorized access.
4. **Session ID is not auth** — The `Mcp-Session-Id` header is routing-only (and unused in stateless mode). Auth is enforced on every request via the API key middleware.
5. **Tool scope** — All 28 tools are exposed. This includes destructive operations (delete schedule, unregister agent). This is intentional for DorkOS's single-user model. External agents have the same capabilities as internal agents.
6. **Input validation** — Tool handlers already validate input via Zod schemas. The MCP SDK validates input against the registered schema before invoking the handler.

## Documentation

- Add "MCP Server" section to `contributing/api-reference.md` with endpoint documentation
- Add client configuration examples to `docs/` (for Fumadocs site)
- Update `CLAUDE.md` to mention the MCP server endpoint
- Add `MCP_API_KEY` to `.env.example` with comment

## Implementation Phases

### Phase 1: Core MCP Server

1. Add `@modelcontextprotocol/sdk` to `apps/server/package.json`
2. Add `MCP_API_KEY` to `env.ts` (Zod `z.string().optional()`)
3. Add `MCP_API_KEY` to `turbo.json` `globalPassThroughEnv`
4. Create `services/core/mcp-server.ts` — `createExternalMcpServer(deps)` factory with all 28 tools
5. Create `middleware/mcp-auth.ts` — API key auth middleware
6. Create `routes/mcp.ts` — POST/GET/DELETE handlers with stateless transport
7. Mount in `index.ts` — wire deps, mount route, add startup log
8. Add `.env.example` entry for `MCP_API_KEY`

### Phase 2: Security, Testing, and Documentation

1. Add Origin validation middleware
2. Write unit tests for auth middleware, origin validation, route handler, and server factory
3. Write integration test (JSON-RPC round-trip)
4. Add client configuration examples to docs
5. Update `contributing/api-reference.md`

## Open Questions

_None — all decisions resolved during ideation._

## Related ADRs

| ADR      | Title                                       | Relevance                                                                                                                                                           |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0070 | Per-Agent Tool Filtering via `allowedTools` | Internal tool filtering mechanism. External MCP server exposes all tools; client-side filtering is the external equivalent.                                         |
| ADR-0068 | Static XML Blocks for Tool Context          | Tool usage documentation injected into internal agent system prompts. External agents do not receive these context blocks (they use MCP tool descriptions instead). |
| ADR-0071 | Implicit Tool Group Hierarchy               | Tools inherit feature flags from parent services. The same guards apply to external tool calls.                                                                     |
| ADR-0062 | Remove Mesh Feature Flag (Always-On)        | Mesh tools are always available. Sets precedent for MCP server being always-on.                                                                                     |

## References

- [MCP Specification 2025-03-26 — Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Authorization Tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- Ideation: `specs/mcp-server/01-ideation.md`
- Research: `research/20260309_mcp_server_express_embedding.md`
- Existing tool architecture: `apps/server/src/services/runtimes/claude-code/mcp-tools/`
