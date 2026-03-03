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

- `200` - SSE stream (when `DORKOS_RELAY_ENABLED` is false). Event types: `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `approval_required`, `question_prompt`, `error`, `done`, `session_status`, `task_update`
- `202` - JSON receipt (when `DORKOS_RELAY_ENABLED` is true). See [POST /sessions/:id/messages (Relay Mode)](#post-apisessionsidmessages-relay-mode) below.
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
- `relay_message` - (Relay mode) Response chunk from a Relay-dispatched agent session. Contains a nested `StreamEvent`.
- `relay_receipt` - (Relay mode) Delivery confirmation for a published Relay message.
- `message_delivered` - (Relay mode) Notification that a message reached its target agent.

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

## Feature Flags

Some route groups are guarded by environment variable feature flags. When a flag is disabled, the router is not mounted and all requests to those paths return 404.

| Flag                       | Default | Guards                              |
| -------------------------- | ------- | ----------------------------------- |
| `DORKOS_RELAY_ENABLED`     | `false` | `/api/relay/*` routes               |
| `DORKOS_MESH_ENABLED`      | `false` | `/api/mesh/*` routes                |

Both flags also control the behavior of `POST /api/sessions/:id/messages`:
- When `DORKOS_RELAY_ENABLED=true`, the endpoint returns 202 + receipt instead of an SSE stream.

Other relevant environment variables:

| Variable              | Default | Description                                                  |
| --------------------- | ------- | ------------------------------------------------------------ |
| `DORKOS_PORT`         | `4242`  | Express server port                                          |
| `DORKOS_CORS_ORIGIN`  | `*`     | CORS `Access-Control-Allow-Origin` value. Set to a specific origin (e.g. `https://app.example.com`) to restrict cross-origin requests. |

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

## Adapter Catalog Endpoints

All adapter catalog endpoints are under `/api/relay/adapters/` and require `DORKOS_RELAY_ENABLED=true`. They are only mounted when `AdapterManager` is available.

### GET /api/relay/adapters/catalog

Returns the full adapter catalog with manifests and running instances for each adapter type.

**Responses:**

- `200` - Array of `CatalogEntry` objects:

```json
[
  {
    "manifest": {
      "type": "telegram",
      "displayName": "Telegram",
      "description": "Send and receive messages via a Telegram bot.",
      "iconEmoji": "\u2708\ufe0f",
      "category": "messaging",
      "builtin": true,
      "multiInstance": false,
      "configFields": [...]
    },
    "instances": [
      {
        "id": "telegram",
        "enabled": true,
        "status": { "state": "connected", "messageCount": { "inbound": 42, "outbound": 15 }, "errorCount": 0 }
      }
    ]
  }
]
```

- `500` - Internal error

### POST /api/relay/adapters

Create a new adapter instance. Persists to `~/.dork/relay/adapters.json` and starts the adapter.

**Request body:**

```json
{
  "type": "webhook",
  "id": "github-webhook",
  "config": {
    "inbound": { "subject": "relay.webhook.github", "secret": "min-16-char-secret" },
    "outbound": { "url": "https://example.com/hook", "secret": "min-16-char-secret" }
  },
  "enabled": true
}
```

All of `type`, `id`, and `config` are required. `enabled` defaults to `true`.

**Responses:**

- `201` - Created: `{ ok: true, id: "github-webhook" }`
- `400` - Missing required fields or validation error
- `409` - Duplicate ID (`DUPLICATE_ID`)
- `400` - Unknown adapter type (`UNKNOWN_TYPE`)
- `400` - Single-instance adapter already exists (`MULTI_INSTANCE_DENIED`)

**Error codes** (in `code` field):

| Code                     | HTTP | Description                                    |
| ------------------------ | ---- | ---------------------------------------------- |
| `DUPLICATE_ID`           | 409  | An adapter with this ID already exists          |
| `UNKNOWN_TYPE`           | 400  | The adapter type is not recognized              |
| `MULTI_INSTANCE_DENIED`  | 400  | Adapter type does not support multiple instances |

### DELETE /api/relay/adapters/:id

Remove an adapter instance. Stops the adapter and removes it from config.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Adapter not found (`NOT_FOUND`)
- `400` - Cannot remove built-in adapter (`REMOVE_BUILTIN_DENIED`)

### PATCH /api/relay/adapters/:id/config

Update an adapter's configuration. Triggers a hot-reload of the adapter.

**Request body:**

```json
{
  "config": {
    "token": "new-bot-token",
    "mode": "webhook"
  }
}
```

The `config` field is required and replaces the adapter's configuration.

**Responses:**

- `200` - `{ ok: true }`
- `400` - Missing `config` field
- `404` - Adapter not found (`NOT_FOUND`)

### POST /api/relay/adapters/test

Test an adapter connection without persisting. Creates a temporary adapter instance, attempts to start it, and reports success or failure.

**Request body:**

```json
{
  "type": "telegram",
  "config": {
    "token": "123456:ABC...",
    "mode": "polling"
  }
}
```

Both `type` and `config` are required.

**Responses:**

- `200` - `{ ok: true }`
- `400` - Missing required fields
- `500` - Test failed: `{ error: "Connection timeout" }`

## Binding Endpoints

All binding endpoints are under `/api/relay/bindings/` and require `DORKOS_RELAY_ENABLED=true`. They manage adapter-to-agent routing rules.

### GET /api/relay/bindings

List all adapter-agent bindings.

**Responses:**

- `200` - `{ bindings: AdapterBinding[] }`
- `503` - Binding subsystem not available

### GET /api/relay/bindings/:id

Get a single binding by ID.

**Responses:**

- `200` - `{ binding: AdapterBinding }`
- `404` - Binding not found
- `503` - Binding subsystem not available

### POST /api/relay/bindings

Create a new adapter-agent binding. Zod-validated via `CreateBindingRequestSchema`.

**Request body:**

```json
{
  "adapterId": "telegram",
  "agentId": "my-agent",
  "projectPath": "/path/to/project",
  "chatId": "12345",
  "channelType": "telegram",
  "sessionStrategy": "per-chat",
  "label": "Telegram to project agent"
}
```

`adapterId`, `agentId`, and `projectPath` are required. `sessionStrategy` defaults to `per-chat`. `chatId`, `channelType`, and `label` are optional.

**Responses:**

- `201` - `{ binding: AdapterBinding }`
- `400` - Validation error
- `503` - Binding subsystem not available

### DELETE /api/relay/bindings/:id

Delete an adapter-agent binding.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Binding not found
- `503` - Binding subsystem not available

## Mesh Endpoints

All mesh endpoints are under `/api/mesh/` and require `DORKOS_MESH_ENABLED=true`. When disabled, the mesh router is not mounted and requests return 404.

Mesh manages an in-memory registry of discovered agent peers. Agents heartbeat to maintain their presence and query the topology to find collaborators.

### POST /api/mesh/discover

Trigger peer discovery for a given working directory. Scans for `.dork/agent.json` files in ancestor and sibling directories.

**Request body:**

```json
{
  "cwd": "/path/to/project"
}
```

**Responses:**

- `200` - `{ candidates: DiscoveryCandidate[] }`
- `400` - Missing `cwd`

### POST /api/mesh/agents

Register an agent in the mesh.

**Request body:** `AgentManifest` (from `@dorkos/shared/mesh-schemas`)

```json
{
  "id": "agent-abc123",
  "name": "backend-agent",
  "cwd": "/path/to/project",
  "runtime": "claude-code"
}
```

**Responses:**

- `201` - Registered `AgentManifest`
- `400` - Validation error

### GET /api/mesh/agents

List all registered agents in the mesh.

**Responses:**

- `200` - `{ agents: AgentManifest[] }`

### PATCH /api/mesh/agents/:id

Update a registered agent's manifest fields.

**Request body:** Partial `AgentManifest`

**Responses:**

- `200` - Updated `AgentManifest`
- `400` - Validation error
- `404` - Agent not found

### DELETE /api/mesh/agents/:id

Unregister an agent from the mesh.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Agent not found

### GET /api/mesh/agents/:id/access

Get the access control list for an agent — which other agents are permitted to communicate with it.

**Responses:**

- `200` - `{ allowedAgents: string[] }`
- `404` - Agent not found

### GET /api/mesh/agents/:id/health

Get health status for a registered agent.

**Responses:**

- `200` - `AgentHealth` object:

```json
{
  "agentId": "agent-abc123",
  "status": "healthy",
  "lastHeartbeat": "2026-02-25T10:00:00Z",
  "uptimeSeconds": 3600
}
```

- `404` - Agent not found

### POST /api/mesh/agents/:id/heartbeat

Record a heartbeat for a registered agent. Agents should call this periodically to maintain their presence in the mesh. Stale agents (no heartbeat within the configured TTL) are removed from active topology.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Agent not found

### GET /api/mesh/topology

Get the full mesh topology — all registered agents and their peer relationships.

**Responses:**

- `200` - `{ agents: AgentManifest[], edges: { from: string, to: string }[] }`

### PUT /api/mesh/topology/access

Update access control rules for the topology. Defines which agents may communicate with which.

**Request body:**

```json
{
  "rules": [
    { "from": "agent-abc123", "to": "agent-def456" }
  ]
}
```

**Responses:**

- `200` - `{ ok: true }`
- `400` - Validation error

### POST /api/mesh/deny

Add an agent to the deny list. Denied agents cannot communicate with any mesh member.

**Request body:**

```json
{
  "agentId": "agent-abc123",
  "reason": "Unauthorized access attempt"
}
```

**Responses:**

- `200` - `{ ok: true }`
- `400` - Missing `agentId`

### GET /api/mesh/denied

List all denied agents.

**Responses:**

- `200` - `{ denied: DenialRecord[] }`

### DELETE /api/mesh/denied/:agentId

Remove an agent from the deny list.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Agent not in deny list

### GET /api/mesh/status

Get overall mesh status — counts of registered, healthy, and denied agents.

**Responses:**

- `200` - `MeshStatus` object:

```json
{
  "totalAgents": 5,
  "healthyAgents": 4,
  "deniedAgents": 1,
  "lastDiscoveryAt": "2026-02-25T10:00:00Z"
}
```

## Models Endpoint

### GET /api/models

Returns the list of Claude models supported by the Agent SDK. Uses the SDK's `supportedModels()` function and includes display names and descriptions for each model.

No feature flag required — always mounted.

**Responses:**

- `200` - Array of model descriptors:

```json
[
  {
    "id": "claude-opus-4-5",
    "name": "Claude Opus 4.5",
    "description": "Most capable model for complex tasks"
  },
  {
    "id": "claude-sonnet-4-5",
    "name": "Claude Sonnet 4.5",
    "description": "Balanced performance and speed"
  }
]
```

## Discovery Endpoint

### POST /api/discovery/scan

SSE endpoint that streams agent discovery results. Performs a BFS filesystem scan for AI-configured projects (CLAUDE.md, .claude/, .cursor/, .dork/agent.json markers). No feature flag required.

**Request body:**

```json
{
  "roots": ["/home/user/projects"],
  "maxDepth": 3,
  "timeout": 30000
}
```

`roots` is required (array of directory paths to scan). `maxDepth` (default 4) and `timeout` (default 30000ms) are optional.

**Response:** `text/event-stream` with these event types:

- `candidate` - Discovered project: `{ path, markers, runtime, name }`
- `progress` - Scan progress: `{ scannedDirs, currentDir }`
- `complete` - Scan finished: `{ totalCandidates, scannedDirs, duration }`
- `error` - Scan error: `{ message }`

All `roots` paths are validated against the configured directory boundary (403 if outside).

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
