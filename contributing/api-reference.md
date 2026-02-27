# API Reference

## Interactive Docs

Start the server and visit:

- **Scalar UI**: [http://localhost:4242/api/docs](http://localhost:4242/api/docs) - interactive API explorer
- **Raw spec**: [http://localhost:4242/api/openapi.json](http://localhost:4242/api/openapi.json) - OpenAPI 3.1 JSON

## How Schemas Work

All request/response types are defined as **Zod schemas** in `packages/shared/src/schemas.ts`. This single file is the source of truth for:

1. **TypeScript types** - via `z.infer<typeof Schema>` (compile-time)
2. **Runtime validation** - via `schema.safeParse(data)` in route handlers
3. **OpenAPI spec** - auto-generated via `@asteasolutions/zod-to-openapi`

Types in `packages/shared/src/types.ts` are re-exported from `schemas.ts`, so all existing imports continue to work.

## Adding a New Endpoint

1. **Define schemas** in `packages/shared/src/schemas.ts` for request/response shapes
2. **Register the path** in `apps/server/src/services/openapi-registry.ts` with tags, request schema, and response schemas
3. **Add validation** in the route handler using `Schema.safeParse(req.body)`:

```typescript
const parsed = MyRequestSchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
}
const { field } = parsed.data;
```

4. Export the inferred type from `packages/shared/src/types.ts` if needed by client code

## SSE Streaming

### POST /api/sessions/:id/messages

The `POST /api/sessions/:id/messages` endpoint returns a `text/event-stream` response. Each SSE message follows the format:

```
event: message
data: {"type":"text_delta","data":{"text":"Hello"}}

```

Event types are documented in the `StreamEventType` enum in the OpenAPI spec. The Scalar UI describes the event format but cannot render live SSE streams.

**Headers:**

- `X-Client-Id` (optional) - Client identifier for session locking. If another client holds the lock, returns 409 `SESSION_LOCKED`.

**Responses:**

- `200` - SSE stream with `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `approval_required`, `error`, `done` events
- `409` - Session locked by another client. Response body: `{ error: 'Session locked', code: 'SESSION_LOCKED', lockedBy: string, lockedAt: string }`

### GET /api/sessions/:id/stream

Persistent SSE connection for session sync. Broadcasts updates when the session's JSONL file changes (including CLI writes).

**Query params:**

- `cwd` (optional) - Working directory path

**Headers:**

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `ETag` - File-based cache tag (mtime + size)

**Events:**

- `sync_connected` - Sent on initial connection. Data: `{ sessionId: string }`
- `sync_update` - Sent when JSONL file changes. Data: `{ sessionId: string, timestamp: string }`

**Usage:** Clients should close the connection when no longer viewing the session.

### GET /api/sessions/:id/messages

Fetch message history for a session.

**Query params:**

- `cwd` (optional) - Working directory path

**Headers:**

- `If-None-Match` (optional) - ETag from previous response. Returns 304 if content unchanged.

**Responses:**

- `200` - Message array with `ETag` header (based on file mtime + size)
- `304` - Not Modified (when `If-None-Match` matches current `ETag`)
- `404` - Session not found

### GET /api/config

Returns server runtime information (version, port, uptime, working directory, tunnel status, Claude CLI path).

**Responses:**

- `200` - Server config JSON

### PATCH /api/config

Update user configuration. Accepts a partial config object that is deep-merged with the current `~/.dork/config.json`. The merged result is validated against `UserConfigSchema` before persisting.

**Request body:** Partial JSON object matching the `UserConfig` shape. Only include fields you want to change.

```json
{
  "server": { "port": 8080 },
  "ui": { "theme": "dark" }
}
```

**Responses:**

- `200` - Success. Returns the full updated config and optional warnings for sensitive fields:

```json
{
  "success": true,
  "config": {
    "version": 1,
    "server": { "port": 8080, "cwd": null },
    "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
    "ui": { "theme": "dark" }
  },
  "warnings": ["'tunnel.authtoken' contains sensitive data. Consider using environment variables instead."]
}
```

The `warnings` field is only present when the patch includes keys listed in `SENSITIVE_CONFIG_KEYS`.

- `400` - Validation failed. Returned when the merged config does not pass Zod validation:

```json
{
  "error": "Validation failed",
  "details": ["server.port: Expected number, received string"]
}
```

- `400` - Non-object body:

```json
{
  "error": "Request body must be a JSON object"
}
```

## Agent Endpoints

Agent identity endpoints are always mounted at `/api/agents/` — no feature flag required. They operate on `.dork/agent.json` files via the shared manifest module. All path parameters are boundary-validated.

### GET /api/agents/current

Get the agent manifest for a working directory.

**Query params:**

- `path` (required) - Absolute path to the project directory

**Responses:**

- `200` - `AgentManifest` object
- `400` - Missing `path` query parameter
- `403` - Path outside configured boundary
- `404` - No agent registered at this path

### POST /api/agents

Create a new agent (writes `.dork/agent.json`).

**Request body:** `CreateAgentRequest`

```json
{
  "path": "/path/to/project",
  "name": "my-agent",
  "description": "Backend API agent",
  "runtime": "claude-code"
}
```

Only `path` is required. `name` defaults to the directory basename, `runtime` defaults to `claude-code`.

**Responses:**

- `201` - Created `AgentManifest`
- `400` - Validation error
- `403` - Path outside configured boundary
- `409` - Agent already exists at this path (returns existing agent)

### PATCH /api/agents/current

Update agent fields by path. Merges the request body into the existing manifest.

**Query params:**

- `path` (required) - Absolute path to the project directory

**Request body:** `UpdateAgentRequest` (all fields optional)

```json
{
  "name": "new-name",
  "description": "Updated description",
  "persona": "You are an expert in REST APIs...",
  "personaEnabled": true,
  "color": "#6366f1",
  "icon": "\ud83e\udd16"
}
```

**Responses:**

- `200` - Updated `AgentManifest`
- `400` - Validation error or missing `path`
- `403` - Path outside configured boundary
- `404` - No agent registered at this path

### POST /api/agents/resolve

Batch-resolve agents for multiple paths. Avoids N+1 queries in the DirectoryPicker.

**Request body:** `ResolveAgentsRequest`

```json
{
  "paths": ["/path/to/project-a", "/path/to/project-b"]
}
```

Maximum 20 paths per request.

**Responses:**

- `200` - `{ agents: Record<string, AgentManifest | null> }` — keys are paths, values are manifests or `null` for unregistered directories

## Relay Endpoints

All relay endpoints are under `/api/relay/` and require `DORKOS_RELAY_ENABLED=true`. When disabled, the relay router is not mounted and requests return 404.

### POST /api/relay/messages

Send a message to a subject pattern.

**Request body:** `SendMessageRequest` (from `@dorkos/shared/relay-schemas`)

```json
{
  "subject": "relay.agent.task-runner",
  "payload": { "content": "Run the tests" },
  "from": "relay.agent.orchestrator",
  "replyTo": "relay.agent.orchestrator",
  "budget": { "maxHops": 5, "ttl": 300000 }
}
```

**Responses:**

- `200` - Message sent: `{ messageId: string, deliveredTo: number }`
- `400` - Validation error

### GET /api/relay/messages

List messages with optional filtering and cursor-based pagination.

**Query params:**

- `subject` (optional) - Filter by subject pattern
- `status` (optional) - Filter by status: `new`, `cur`, `failed`
- `from` (optional) - Filter by sender
- `cursor` (optional) - ULID cursor for pagination
- `limit` (optional, default 50, max 100)

**Responses:**

- `200` - `{ messages: RelayEnvelope[], cursor?: string }`

### GET /api/relay/messages/:id

Get a single message by ID.

**Responses:**

- `200` - `RelayEnvelope`
- `404` - Message not found

### GET /api/relay/endpoints

List all registered endpoints.

**Responses:**

- `200` - Array of `{ subject: string, description?: string }`

### POST /api/relay/endpoints

Register a new endpoint.

**Request body:** `EndpointRegistration`

```json
{
  "subject": "relay.agent.my-agent",
  "description": "My custom agent endpoint"
}
```

**Responses:**

- `201` - `{ subject: string, created: boolean }`
- `400` - Validation error

### DELETE /api/relay/endpoints/:subject

Unregister an endpoint.

**Responses:**

- `200` - `{ success: boolean }`
- `404` - Endpoint not found

### GET /api/relay/endpoints/:subject/inbox

Read inbox messages for a specific endpoint.

**Query params:**

- `status` (optional) - Filter by status
- `cursor` (optional) - ULID cursor
- `limit` (optional, default 50, max 100)

**Responses:**

- `200` - `{ messages: RelayEnvelope[], cursor?: string }`
- `404` - Endpoint not found

### GET /api/relay/dead-letters

List dead-letter messages (undeliverable).

**Query params:** Same as GET /api/relay/messages.

**Responses:**

- `200` - `{ messages: RelayEnvelope[], cursor?: string }`

### GET /api/relay/metrics

Relay system metrics.

**Responses:**

- `200` - `{ totalMessages: number, totalEndpoints: number, totalDeadLetters: number }`

### GET /api/relay/stream

SSE event stream for real-time relay activity. Supports server-side subject filtering.

**Query params:**

- `subject` (optional) - Subject pattern filter (e.g., `relay.agent.*`)

**Events:**

- `relay_connected` - Connection established
- `relay_message` - New message published
- `relay_delivery` - Message delivered to endpoint
- `relay_dead_letter` - Message became dead letter
- `relay_metrics` - Periodic metrics update

**Keepalive:** `: keepalive\n\n` comment every 15 seconds.

**Usage:** Clients should close the EventSource when the relay panel is not visible.

### POST /api/sessions/:id/messages (Relay Mode)

When `DORKOS_RELAY_ENABLED` is true, this endpoint publishes the message to Relay instead of streaming directly. The response changes from SSE to a JSON receipt.

**Responses:**

- `202` - Message accepted for Relay delivery:

```json
{
  "messageId": "01HXYZ...",
  "traceId": "tr_01HXYZ..."
}
```

Response chunks are delivered asynchronously via the SSE stream (`GET /api/sessions/:id/stream`) as `relay_message` events.

### GET /api/relay/messages/:id/trace

Get delivery trace for a specific message. Requires `DORKOS_RELAY_ENABLED=true`.

**Responses:**

- `200` - Trace with spans:

```json
{
  "traceId": "tr_01HXYZ...",
  "spans": [
    {
      "spanId": "sp_01HXYZ...",
      "messageId": "01HXYZ...",
      "subject": "relay.agent.session-123",
      "operation": "publish",
      "status": "completed",
      "startedAt": "2026-02-25T10:00:00Z",
      "completedAt": "2026-02-25T10:00:01Z"
    }
  ]
}
```

- `404` - Message not found

### GET /api/relay/trace/metrics

Aggregate delivery metrics for the Relay system. Requires `DORKOS_RELAY_ENABLED=true`.

**Responses:**

- `200` - `DeliveryMetrics` aggregate:

```json
{
  "totalMessages": 1234,
  "totalDelivered": 1200,
  "totalFailed": 34,
  "avgDeliveryMs": 45.2,
  "p99DeliveryMs": 210.5
}
```

## Validation Errors

Invalid requests return HTTP 400 with a structured error body:

```json
{
  "error": "Invalid request",
  "details": {
    "content": { "_errors": ["Required"] }
  }
}
```

The `details` field contains Zod's formatted error output, mapping field names to their validation errors.
