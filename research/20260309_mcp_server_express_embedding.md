---
title: 'MCP Server Embedding in Express — Transport Options, Auth, and Integration Patterns'
date: 2026-03-09
type: external-best-practices
status: active
tags:
  [mcp, mcp-server, express, streamable-http, sse, stdio, authentication, transport, tool-schema]
feature_slug: mcp-server
searches_performed: 9
sources_count: 18
---

# MCP Server Embedding in Express — Transport Options, Auth, and Integration Patterns

## Research Summary

The Model Context Protocol (MCP) 2025-03-26 specification replaced the old HTTP+SSE transport with **Streamable HTTP**, a single-endpoint design that supports both request-response and streaming patterns. The official `@modelcontextprotocol/sdk` npm package (`McpServer` + `StreamableHTTPServerTransport`) is the correct TypeScript implementation and can be embedded directly into an existing Express app by mounting POST/GET/DELETE handlers on an `/mcp` router. Auth is optional for local servers but should use a static API key (pre-shared secret) for DorkOS's self-hosted use case, rather than the full OAuth 2.1 flow required by public-facing servers. The tool definitions DorkOS already maintains for its internal SDK injection (`mcp-tools/`) can be directly re-exposed via this external MCP server with minimal structural duplication.

---

## Key Findings

### 1. The MCP Specification Transport Landscape (2025)

The MCP spec (version 2025-03-26) defines two standard transports:

- **stdio** — client launches the server as a subprocess, communicates via stdin/stdout. Local only, single-client, no network overhead.
- **Streamable HTTP** — server operates as an independent HTTP process. Single endpoint (e.g., `/mcp`) handles both `POST` and `GET`. Optional SSE streaming within that endpoint for long-running responses.

The older **HTTP+SSE** transport (2024-11-05) is deprecated but servers can support it alongside Streamable HTTP for backward compatibility. Claude Desktop, Claude Code, Cursor, and Windsurf all support Streamable HTTP as of early 2025.

### 2. Streamable HTTP: The Recommended Remote Transport

Streamable HTTP was introduced specifically to fix the problems with HTTP+SSE:

- **Single endpoint** at `/mcp` (or any path) — no separate SSE and POST endpoints
- **Stateless-capable** — set `sessionIdGenerator: undefined` to run without session affinity (good for simple deployments)
- **Stateful-capable** — set a UUID generator and store transports in a `Map<sessionId, transport>` for multi-turn sessions
- **Can optionally upgrade to SSE** — when the server returns `Content-Type: text/event-stream` for a POST request, the client reads streaming responses; otherwise it reads a single JSON response
- **GET requests** on the same endpoint open a persistent SSE stream for server-initiated messages

### 3. Embedding in an Existing Express App

The SDK's `StreamableHTTPServerTransport` is designed to plug directly into Express handlers. The pattern:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';

// Session store — lives outside the handler so it persists across requests
const sessions = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'dorkos', version: '1.0.0' });
  // register tools here
  return server;
}

export function createMcpRouter(): Router {
  const router = Router();

  // POST: new requests and tool calls
  router.post('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Resume existing session
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Initialize new session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: invalid session' },
        id: null,
      });
    }
  });

  // GET: server-initiated SSE stream
  router.get('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid session ID');
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
  });

  // DELETE: explicit session termination
  router.delete('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).send('Session not found');
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
  });

  return router;
}
```

Then in `app.ts` or `index.ts`:

```typescript
app.use('/mcp', createMcpRouter());
```

This mounts the MCP server at `http://localhost:4242/mcp`. External clients configure their MCP connection as `http://localhost:4242/mcp` (type: `http`).

### 4. Stateless Alternative (Simpler But Limited)

For DorkOS tools that are purely request-response (no server-initiated push), a stateless transport can simplify session management:

```typescript
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
});
const server = createMcpServer();
await server.connect(transport);

router.post('/', async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});
```

**Caveat:** Stateless mode means a fresh server context per request — the same `McpServer` instance is reused but there is no persistent client state between calls. This is fine for DorkOS tools since each tool call is independent (no multi-turn negotiation within the MCP protocol itself).

### 5. Authentication Patterns

Auth is **optional** for MCP servers per the spec, but recommended for any non-localhost deployment. Three practical options for DorkOS:

#### Option A: Static API Key (Recommended for DorkOS)

A simple middleware that checks a pre-shared secret from `Authorization: Bearer <key>`:

```typescript
function mcpApiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const key = env.MCP_API_KEY; // from env.ts via Zod
  if (!key) {
    next();
    return;
  } // auth disabled if no key configured

  const authHeader = req.headers.authorization ?? '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || token !== key) {
    res.status(401).json({
      error: 'Unauthorized',
      hint: 'Set Authorization: Bearer <MCP_API_KEY>',
    });
    return;
  }
  next();
}

app.use('/mcp', mcpApiKeyAuth, createMcpRouter());
```

Clients configure the key via their MCP client's `headers` option:

```json
{
  "url": "http://localhost:4242/mcp",
  "type": "http",
  "headers": { "Authorization": "Bearer <your-key>" }
}
```

#### Option B: Full OAuth 2.1 (For Public/Multi-User Deployments)

The MCP SDK ships `requireBearerAuth` middleware and `mcpAuthMetadataRouter` from `@modelcontextprotocol/sdk/server/auth/`. This implements the full OAuth 2.1 discovery + PKCE flow with an external authorization server (Keycloak, Auth0, etc.). Required only if DorkOS is exposed as a multi-tenant public service. **Out of scope for the current feature.**

#### Option C: No Auth (Local Only)

Acceptable when DorkOS is bound to localhost only (`127.0.0.1`) and the MCP server is only accessible from the same machine. The spec allows this explicitly for local servers.

### 6. Discovery — How Clients Find the MCP Server

MCP clients are configured manually (no automatic discovery). The external client needs:

- The URL: `http://localhost:4242/mcp` (or ngrok tunnel equivalent)
- Transport type: `http` (Streamable HTTP)
- Optional: API key header

Example configurations for common clients:

**Claude Code (`~/.claude/settings.json`)**:

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

**Cursor / Windsurf** — add via MCP server settings UI with URL `http://localhost:4242/mcp`.

### 7. Tool Schema Definition — Reusing Existing mcp-tools/

DorkOS already defines its tools using `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk` for internal agent injection. The external MCP server needs tools defined using `McpServer` from `@modelcontextprotocol/sdk`. **These are two different SDKs with slightly different APIs.**

The tool handler functions themselves (e.g., `handlePing`, `createRelaySendHandler`) are pure async functions that can be shared. Only the registration wrapper differs:

**Current (internal, Claude Agent SDK):**

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
createSdkMcpServer({
  name: 'dorkos',
  tools: [tool('ping', 'description', {}, handlePing)],
});
```

**External (standard MCP SDK):**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server = new McpServer({ name: 'dorkos', version: '1.0.0' });
server.registerTool(
  'ping',
  {
    description: 'description',
    inputSchema: z.object({}),
  },
  handlePing
);
```

The handlers stay identical. A thin adapter or factory pattern bridges the two registration styles.

### 8. Security Requirements from the Spec

The MCP specification has hard security requirements for Streamable HTTP:

1. **Validate `Origin` header** on all incoming connections to prevent DNS rebinding attacks
2. **Bind only to localhost** (`127.0.0.1`) for local deployments, not `0.0.0.0`
3. **Implement authentication** for all connections when exposed beyond localhost

The `@modelcontextprotocol/express` helper package handles #1 automatically (Host header validation). If not using that package, middleware must manually validate `Origin`.

---

## Detailed Analysis

### Approach Comparison

#### 1. Streamable HTTP — Embedded in Express (RECOMMENDED)

**Description:** Mount a `StreamableHTTPServerTransport` on an Express router at `/mcp`. The DorkOS Express server handles MCP alongside its existing REST and SSE endpoints. No new process.

**Pros:**

- Zero new process management — same lifecycle as the Express server
- Direct access to all singleton services (relay, pulse, mesh, config) without IPC
- Single port exposed (existing `DORKOS_PORT`) — works through existing ngrok tunnel
- No new dependency on process spawning or stdio piping
- Tool handlers are pure functions — can share code with internal agent injection
- Sessions map into the Express process memory — no external state store needed for simple cases
- Compatible with Claude Code, Claude Desktop, Cursor, Windsurf, and any MCP client supporting Streamable HTTP

**Cons:**

- MCP sessions held in process memory — server restart clears sessions (clients must re-initialize, which they handle automatically)
- Adds state (`sessions` Map) to the Express process — need cleanup on session close/expiry
- The `McpServer` tool registration API differs from the internal Claude Agent SDK API — requires a thin wrapper to reuse handler functions

**Complexity:** Low. Three route handlers + one `McpServer` factory + auth middleware.

**Maintenance:** Low. The `@modelcontextprotocol/sdk` package is the official MCP TypeScript SDK, well-maintained by Anthropic.

---

#### 2. Legacy HTTP+SSE Transport — Embedded in Express

**Description:** Two endpoints: `GET /mcp` returns an SSE stream, `POST /mcp/messages` accepts requests. The older 2024-11-05 transport.

**Pros:**

- Some older MCP clients only support SSE (pre-2025 versions)
- Can be run alongside Streamable HTTP for backward compatibility

**Cons:**

- Deprecated as of MCP spec 2025-03-26
- More complex session management (permanent SSE connection required)
- Security weaknesses: auth tokens passed in URL query strings, auth only checked at connection time
- DNS rebinding vulnerabilities easier to exploit

**Complexity:** Medium. Two endpoints with tighter coupling between them.

**Maintenance:** High risk — this transport is heading toward removal.

**Recommendation:** Do not implement as primary transport. Optionally add for backward compat after Streamable HTTP is stable.

---

#### 3. Stdio Transport — Separate Script

**Description:** A separate Node.js entry point (e.g., `packages/cli/src/mcp-server.ts`) that reads from stdin and writes to stdout. Clients spawn this process directly.

**Pros:**

- Works with Claude Desktop's "local process" MCP configuration style
- No network stack required — pure IPC
- Isolation: MCP server crash does not crash Express

**Cons:**

- Requires a second process to be running (or spawned per client) — operational complexity
- No direct access to the live Express singletons (relay, pulse, mesh) without IPC layer or shared database reads
- Cannot share sessions with Express HTTP clients
- Does not work as a remote MCP server (no network access)
- Cannot be used via the ngrok tunnel DorkOS already exposes

**Complexity:** Medium-High. Separate entry point + IPC or DB-based service access.

**Maintenance:** High. Two server processes to keep in sync with service changes.

**Recommendation:** Add as a secondary option later, specifically for users who want to use Claude Desktop's local process model. Not the primary implementation.

---

#### 4. Standalone MCP Server Process — Separate Node.js Service

**Description:** A dedicated Express-like server (or raw HTTP server) that runs exclusively as an MCP server on a separate port.

**Pros:**

- Complete process isolation
- Could be scaled independently

**Cons:**

- All the IPC/DB-sharing problems of Option 3, plus a second port
- Operationally complex — now two servers to start, monitor, and configure
- The DorkOS CLI (`dorkos start`) would need to spawn and manage two processes
- No benefit over Option 1 for DorkOS's single-user, local-first use case

**Complexity:** High. New package or app in the monorepo.

**Maintenance:** High. Completely separate server lifecycle.

**Recommendation:** Explicitly avoid. Over-engineered for DorkOS's needs.

---

### DorkOS-Specific Architecture Fit

DorkOS already has:

- All tool handler functions in `apps/server/src/services/runtimes/claude-code/mcp-tools/` — pure async functions that can be re-used
- `McpToolDeps` interface for dependency injection into handlers
- An Express app with existing middleware (CORS, auth patterns, SSE)
- A `DORKOS_PORT` environment variable (env.ts, Zod-validated)
- ngrok tunnel support via `tunnel-manager.ts` — external MCP clients can connect via tunnel

The Streamable HTTP embedded approach slots in naturally. A new route file `routes/mcp.ts` and a new service file `services/core/mcp-server.ts` are the primary additions. The `McpToolDeps` type is already present and carries all needed service references.

**File impact estimate:**

| File                                          | Change                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| `apps/server/src/routes/mcp.ts`               | New — POST/GET/DELETE handlers, session map          |
| `apps/server/src/services/core/mcp-server.ts` | New — `McpServer` factory, tool registration adapter |
| `apps/server/src/app.ts`                      | Modify — mount `/mcp` router                         |
| `apps/server/src/env.ts`                      | Modify — add `MCP_API_KEY` optional env var          |
| `apps/server/package.json`                    | Modify — add `@modelcontextprotocol/sdk` dependency  |

---

## Security Considerations

1. **Origin header validation** is a hard requirement from the spec to prevent DNS rebinding. The `@modelcontextprotocol/express` package handles this automatically. Without it, DorkOS must manually validate `Origin` in the MCP middleware.

2. **Bind to localhost by default.** When the MCP server is local-only, the Express server (already on `DORKOS_PORT`) should remain bound to `127.0.0.1`. External access goes through the ngrok tunnel (HTTPS), which provides transport security.

3. **API key protects the tunnel.** If ngrok is active, the MCP endpoint becomes publicly reachable at the tunnel URL. An API key check (`MCP_API_KEY` env var) must be enforced on the `/mcp` route when a tunnel is active.

4. **Tool scope creep risk.** Exposing DorkOS tools externally means external agents can trigger relay sends, session creation, schedule mutations, and mesh operations. Tools exposed externally should be carefully reviewed. A conservative first pass exposes only read-only tools (ping, list-sessions, get-server-info) and specific relay tools explicitly requested by the external agent owner.

5. **Session ID is not a secret.** The `Mcp-Session-Id` header must not be used as authentication — it is a routing hint only. Auth must be enforced on every request, not just initialization.

6. **Session cleanup.** The `sessions` Map grows unbounded if sessions are never closed. The `transport.onclose` callback handles explicit closes. A TTL-based cleanup (e.g., purge sessions inactive for 30 minutes) prevents memory leaks.

---

## Performance Considerations

1. **In-process transport eliminates IPC latency.** Direct function calls into service singletons are ~0ms vs. network IPC. For tool handlers that call relay, pulse, or mesh services, this is significant.

2. **Session Map is in-process.** For DorkOS's single-user use case, the Map will never exceed a handful of entries (one per client tool connection). No external state store needed.

3. **Streaming tool results.** Some DorkOS tools (e.g., `relay_query`) are inherently async and return after a wait. The Streamable HTTP transport handles this naturally — the POST response can be an SSE stream that emits the result when ready, rather than blocking the HTTP connection.

4. **McpServer instance per session vs. singleton.** The example above creates a new `McpServer` per session initialization. For DorkOS, creating a single `McpServer` instance at startup and reusing it across sessions (via the stateless transport mode) may be simpler and more efficient.

---

## Recommendation

**Recommended Approach:** Streamable HTTP transport embedded in Express (Option 1)

**Rationale:**

- Lowest complexity — three route handlers on a new Express router
- No new process management overhead
- Direct access to all live DorkOS singletons (relay, pulse, mesh) without IPC
- Single port — works through the existing ngrok tunnel
- Matches the current MCP specification (2025-03-26 Streamable HTTP)
- The official `@modelcontextprotocol/sdk` is well-maintained, ships with TypeScript types, and has first-class Express integration support
- Tool handler functions can be reused directly from `mcp-tools/` with only a registration wrapper change

**Implementation order:**

1. Add `@modelcontextprotocol/sdk` as a dependency in `apps/server/package.json`
2. Create `apps/server/src/services/core/mcp-server.ts` — `McpServer` factory that registers DorkOS tools using the MCP SDK's `server.registerTool()` API, re-using existing handler functions from `mcp-tools/`
3. Create `apps/server/src/routes/mcp.ts` — POST/GET/DELETE handlers with session management Map
4. Add `MCP_API_KEY` optional env var to `apps/server/src/env.ts` (Zod `z.string().optional()`)
5. Mount `/mcp` router in `app.ts` with API key middleware (only active when `MCP_API_KEY` is set)
6. Add CORS `Mcp-Session-Id` to exposed headers (alongside existing `X-Client-Id`)

**Caveats:**

- The `McpServer` (external MCP SDK) and `createSdkMcpServer()` (internal Claude Agent SDK) are different APIs. Tool handler functions are reusable; only registration wrappers differ. This duplication is acceptable and intentional — the two contexts (internal agent injection vs. external MCP server) have different lifecycles and requirements.
- For the first iteration, expose only a curated subset of tools externally (e.g., ping, get-server-info, relay-send, relay-inbox, session-list). Exposing destructive operations (delete-schedule, unregister-agent) externally requires explicit consideration.
- Session cleanup (TTL eviction for idle sessions) should be implemented from day one to prevent memory leaks.
- The `Origin` header validation requirement from the MCP spec must be implemented — either via `@modelcontextprotocol/express` or a manual middleware.

---

## Research Gaps and Limitations

1. **`@modelcontextprotocol/express` package** — referenced in search results but documentation is sparse. May simplify Express integration further. Worth inspecting the package source before the implementation phase.

2. **Claude Code MCP client configuration** — confirmed that Claude Code supports HTTP-type MCP servers in `settings.json`, but the exact config syntax for specifying auth headers in Claude Code's MCP client has not been verified. Needs confirmation during implementation.

3. **Tool result streaming within Streamable HTTP** — the spec allows SSE-streamed responses from POST requests, but the SDK's `StreamableHTTPServerTransport` behavior for long-running handlers (like `relay_query` with 120s timeout) needs to be tested. Does the transport hold the HTTP connection open, or does it timeout?

4. **Stateless vs. stateful session mode for DorkOS** — the stateless mode (`sessionIdGenerator: undefined`) may be sufficient since DorkOS tools are stateless request-response. Needs a decision before implementation.

---

## Contradictions and Disputes

- The MCP spec says auth is "optional" but "strongly recommended" for non-localhost deployments. Some community guides treat auth as required. For DorkOS, the correct position is: auth is optional for local-only (127.0.0.1) use, required when ngrok tunnel is active.
- Some older community examples still use the deprecated HTTP+SSE pattern. The current spec (2025-03-26) is unambiguous: Streamable HTTP is the standard. Any guide referencing a separate `/sse` endpoint and a separate `/messages` POST endpoint is describing the deprecated transport.

---

## Sources and Evidence

- MCP Specification 2025-03-26 — Transports: [Transports - Model Context Protocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- MCP Authorization Tutorial: [Understanding Authorization in MCP](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- TypeScript SDK npm package: [@modelcontextprotocol/sdk - npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- TypeScript SDK GitHub: [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- MCP SDK v2 docs: [MCP TypeScript SDK (V2)](https://ts.sdk.modelcontextprotocol.io/v2/)
- "Why MCP Deprecated SSE" — comprehensive rationale: [fka.dev blog](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- Auth0 on Streamable HTTP security benefits: [Auth0 Blog](https://auth0.com/blog/mcp-streamable-http/)
- Transport comparison (stdio/SSE/Streamable): [MCPcat Guide](https://mcpcat.io/guides/comparing-stdio-sse-streamablehttp/)
- Roo Code transport documentation: [Roo Code MCP Transports](https://docs.roocode.com/features/mcp/server-transports)
- Building production MCP servers: [DEV Community](https://dev.to/shadid12/how-to-build-mcp-servers-with-typescript-sdk-1c28)
- Express embed example with session management: [Level Up Coding / Medium](https://levelup.gitconnected.com/mcp-server-and-client-with-sse-the-new-streamable-http-d860850d9d9d)
- Stateless transport pattern: [mcp-sdk GitHub issues #220](https://github.com/modelcontextprotocol/typescript-sdk/issues/220)
- DorkOS existing MCP tool server: `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts`
- DorkOS server entry point: `apps/server/src/index.ts`
- Prior research (internal tool injection): `research/mcp-tool-injection-patterns.md`
- Prior research (relay + subagent MCP): `research/20260304_relay_async_query_and_subagent_mcp.md`

---

## Search Methodology

- Searches performed: 9 web searches + 4 WebFetch calls
- Most productive search terms: "StreamableHTTPServerTransport McpServer Express router mount existing app", "MCP streamable HTTP transport vs SSE 2025 specification", "MCP server bearer token API key authentication Express"
- Primary information sources: modelcontextprotocol.io (official spec), github.com/modelcontextprotocol/typescript-sdk, npm @modelcontextprotocol/sdk
- DorkOS source files read: index.ts, mcp-tools/index.ts
- Existing research leveraged: mcp-tool-injection-patterns.md (tool handler reuse pattern), 20260304_relay_async_query_and_subagent_mcp.md (subagent MCP access context)
