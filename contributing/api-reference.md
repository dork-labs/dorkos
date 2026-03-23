# API Reference

## Interactive Docs

Start the server and visit:

- **Scalar UI**: [http://localhost:6242/api/docs](http://localhost:6242/api/docs) - interactive API explorer
- **Raw spec**: [http://localhost:6242/api/openapi.json](http://localhost:6242/api/openapi.json) - OpenAPI 3.1 JSON

## How Schemas Work

Request/response types are defined as **Zod schemas** in `packages/shared/src/`. Three schema files cover different domains:

- `schemas.ts` — Sessions, commands, health, pulse, models, capabilities
- `relay-schemas.ts` — Relay envelopes, adapters, bindings, catalog
- `mesh-schemas.ts` — Agent manifests, discovery, topology, access control

Each schema serves three roles:

1. **TypeScript types** — via `z.infer<typeof Schema>` (compile-time)
2. **Runtime validation** — via `schema.safeParse(data)` in route handlers
3. **OpenAPI spec** — auto-generated via `@asteasolutions/zod-to-openapi` in `services/core/openapi-registry.ts`

Types in `packages/shared/src/types.ts` re-export from `schemas.ts`, so existing `import { Session } from '@dorkos/shared/types'` imports continue to work.

## Adding a New Endpoint

1. **Define schemas** in the appropriate `packages/shared/src/` file (`schemas.ts`, `relay-schemas.ts`, or `mesh-schemas.ts`) for request/response shapes
2. **Register the path** in `apps/server/src/services/core/openapi-registry.ts` with tags, request schema, and response schemas
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

- `200` - SSE stream. Event types: `text_delta`, `thinking_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `tool_progress`, `approval_required`, `question_prompt`, `error`, `done`, `session_status`, `task_update`, `subagent_started`, `subagent_progress`, `subagent_done`, `rate_limit`, `system_status`, `compact_boundary`, `prompt_suggestion`
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

### GET /api/sessions/:id/tasks

Fetch the current task list (TodoWrite state) for a session.

**Query params:**

- `cwd` (optional) - Working directory path

**Headers:**

- `If-None-Match` (optional) - ETag from previous response. Returns 304 if content unchanged.

**Responses:**

- `200` - `{ tasks: Task[] }` with `ETag` header
- `304` - Not Modified (when `If-None-Match` matches current `ETag`)
- `404` - Session not found

### GET /api/config

Returns server runtime information (version, port, uptime, working directory, tunnel status, Claude CLI path).

**Responses:**

- `200` - Server config JSON

**Notable response fields:**

| Field                      | Type             | Description                                                                                                                                                                         |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | `string`         | Current server version string                                                                                                                                                       |
| `latestVersion`            | `string \| null` | Latest version from npm, or `null` if dev mode or lookup failed                                                                                                                     |
| `isDevMode`                | `boolean`        | Whether the server is running a development build (from `pnpm dev` or `tsx watch`). When `true`, `latestVersion` will be `null` and upgrade notifications are suppressed in the UI. |
| `dismissedUpgradeVersions` | `string[]`       | List of version strings the user has dismissed upgrade notifications for. Managed via `PATCH /api/config` with `{ ui: { dismissedUpgradeVersions: [...] } }`.                       |

### PATCH /api/config

Update user configuration. Accepts a partial config object that is deep-merged with the current `~/.dork/config.json`. The merged result is validated against `UserConfigSchema` before persisting.

**Request body:** Partial JSON object matching the `UserConfig` shape. Only include fields you want to change.

```json
{
  "server": { "port": 8080 },
  "ui": { "theme": "dark" },
  "agentContext": {
    "relayTools": true,
    "meshTools": true,
    "adapterTools": true,
    "pulseTools": false
  }
}
```

The `agentContext` section controls global tool domain toggles. Each toggle determines whether the corresponding MCP tool group is injected into agent sessions by default. Per-agent overrides are set via `enabledToolGroups` on the agent manifest (see [PATCH /api/agents/current](#patch-apiagentscurrent)).

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
  "warnings": [
    "'tunnel.authtoken' contains sensitive data. Consider using environment variables instead."
  ]
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

## Pulse Scheduler (`routes/pulse.ts`)

Feature-flag guarded via `DORKOS_PULSE_ENABLED`. Router is mounted at `/api/pulse`.

| Method | Path                               | Description                   |
| ------ | ---------------------------------- | ----------------------------- |
| GET    | `/api/pulse/schedules`             | List all schedules            |
| POST   | `/api/pulse/schedules`             | Create a schedule             |
| PATCH  | `/api/pulse/schedules/:id`         | Update a schedule             |
| DELETE | `/api/pulse/schedules/:id`         | Delete a schedule             |
| POST   | `/api/pulse/schedules/:id/trigger` | Trigger a schedule run        |
| GET    | `/api/pulse/runs`                  | Get run history               |
| GET    | `/api/pulse/runs/:id`              | Get a specific run            |
| POST   | `/api/pulse/runs/:id/cancel`       | Cancel an active run          |
| GET    | `/api/pulse/presets`               | List default schedule presets |

Schedules support an optional `agentId` field for agent-linked scheduling. When `agentId` is set, the schedule's CWD is resolved from the agent's registered project path via MeshCore.

## Feature Flags

The Relay route group is guarded by an environment variable feature flag. When disabled, the router is not mounted and all requests to those paths return 404. Mesh routes are always mounted (no feature flag).

| Flag                   | Default | Guards                                                        |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `DORKOS_RELAY_ENABLED` | `false` | `/api/relay/*` routes                                         |
| `DORKOS_A2A_ENABLED`   | `false` | `/.well-known/agent.json`, `/a2a/*` (requires Relay to be on) |

This flag also controls the behavior of `POST /api/sessions/:id/messages`:

- `DORKOS_RELAY_ENABLED` enables relay infrastructure for external adapters (Telegram, webhooks). The web client always uses direct SSE streaming regardless of this flag.

Other relevant environment variables:

| Variable               | Default              | Description                                                                                                                            |
| ---------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DORKOS_PORT`          | `4242` (dev: `6242`) | Express server port                                                                                                                    |
| `DORKOS_CORS_ORIGIN`   | `*`                  | CORS `Access-Control-Allow-Origin` value. Set to a specific origin (e.g. `https://app.example.com`) to restrict cross-origin requests. |
| `DORKOS_PULSE_ENABLED` | `false`              | `/api/schedules/*` and `/api/runs/*` routes                                                                                            |

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
  "icon": "\ud83e\udd16",
  "enabledToolGroups": {
    "pulse": true,
    "relay": false,
    "mesh": true,
    "adapter": true
  }
}
```

All fields are optional. The `enabledToolGroups` object controls per-agent tool domain toggles. Omitted fields inherit the global default from the `agentContext` section in `~/.dork/config.json`.

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

### GET /api/relay/conversations

Grouped request/response exchanges with human-readable labels. Builds structured conversations from relay messages by pairing requests with their replies and resolving agent/session names.

**Responses:**

- `200` - `{ conversations: Conversation[] }`
- `500` - Server error

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

### POST /api/relay/adapters/reload

Hot-reload adapter configuration from disk without server restart.

**Responses:**

- `200` - `{ ok: true }`
- `500` - Reload failed

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

| Code                    | HTTP | Description                                      |
| ----------------------- | ---- | ------------------------------------------------ |
| `DUPLICATE_ID`          | 409  | An adapter with this ID already exists           |
| `UNKNOWN_TYPE`          | 400  | The adapter type is not recognized               |
| `MULTI_INSTANCE_DENIED` | 400  | Adapter type does not support multiple instances |

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

`adapterId`, `agentId`, and `projectPath` are required. `sessionStrategy` defaults to `per-chat`. `permissionMode` defaults to `acceptEdits` (controls the Claude Code permission mode for sessions created by this binding). `chatId`, `channelType`, and `label` are optional.

**Responses:**

- `201` - `{ binding: AdapterBinding }`
- `400` - Validation error
- `503` - Binding subsystem not available

### PATCH /api/relay/bindings/:id

Update an existing binding's fields.

**Request body:** Partial update — all fields optional:

```json
{
  "sessionStrategy": "per-chat",
  "label": "Updated label",
  "chatId": "67890",
  "channelType": "telegram"
}
```

**Responses:**

- `200` - `{ binding: AdapterBinding }`
- `400` - Validation error
- `404` - Binding not found
- `503` - Binding subsystem not available

### DELETE /api/relay/bindings/:id

Delete an adapter-agent binding.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Binding not found
- `503` - Binding subsystem not available

## Mesh Endpoints

All mesh endpoints are under `/api/mesh/` and are always mounted (no feature flag). The Mesh subsystem initializes automatically on server startup.

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

### GET /api/mesh/agents/paths

Lightweight agent list returning only IDs and project paths. Used by onboarding and scheduling UIs.

**Responses:**

- `200` - `{ agents: { id: string, projectPath: string }[] }`

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
  "rules": [{ "from": "agent-abc123", "to": "agent-def456" }]
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

Returns the list of Claude models supported by the active runtime. Delegates to `runtimeRegistry.getDefault().getSupportedModels()` and includes display names and descriptions for each model.

No feature flag required — always mounted.

**Responses:**

- `200` - `{ models: ModelOption[] }`:

```json
{
  "models": [
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
}
```

## Capabilities Endpoint

### GET /api/capabilities

Returns capability flags for all registered agent runtimes and the current default runtime type. This enables the client to gate UI features (e.g., tool approval, cost tracking) behind runtime capability checks.

No feature flag required — always mounted.

**Responses:**

- `200` - Runtime capabilities map:

```json
{
  "capabilities": {
    "claude-code": {
      "type": "claude-code",
      "supportsPermissionModes": true,
      "supportedPermissionModes": ["default", "plan", "bypassPermissions"],
      "supportsToolApproval": true,
      "supportsCostTracking": true,
      "supportsResume": true,
      "supportsMcp": true,
      "supportsQuestionPrompt": true
    }
  },
  "defaultRuntime": "claude-code"
}
```

The `capabilities` object is keyed by runtime type string. Each value is a `RuntimeCapabilities` object (defined in `@dorkos/shared/agent-runtime`). The `defaultRuntime` field indicates which runtime is currently active.

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

## File Uploads

### POST /api/uploads

Upload files to a session's working directory for agent access. Files are stored in `{cwd}/.dork/.temp/uploads/` with sanitized filenames. The returned `savedPath` values can be injected into message text so the agent reads them with its existing filesystem tools.

**Content-Type:** `multipart/form-data`

**Query parameters:**

| Parameter | Type   | Required | Description                                  |
| --------- | ------ | -------- | -------------------------------------------- |
| `cwd`     | string | Yes      | Working directory where files will be stored |

**Form field:** `files` (one or more files)

**Limits** (from `uploads` config section):

| Setting        | Default | Description                         |
| -------------- | ------- | ----------------------------------- |
| `maxFileSize`  | 10 MB   | Maximum size per file               |
| `maxFiles`     | 10      | Maximum number of files per request |
| `allowedTypes` | `*/*`   | MIME type filter                    |

**Success response (200):**

```json
{
  "uploads": [
    {
      "originalName": "design.png",
      "savedPath": "/home/user/myproject/.dork/.temp/uploads/1741567200000-design.png",
      "filename": "1741567200000-design.png",
      "size": 204800,
      "mimeType": "image/png"
    }
  ]
}
```

**Error responses:**

- `400` — Missing `cwd`, no files provided, file too large, or MIME type not allowed
- `403` — `cwd` is outside the configured directory boundary

### GET /api/uploads/:filename

Serve an uploaded file by filename. Used by the client to render image thumbnails in chat history.

**Path parameters:**

| Parameter  | Type   | Description                                     |
| ---------- | ------ | ----------------------------------------------- |
| `filename` | string | Sanitized filename (as returned by POST upload) |

**Query parameters:**

| Parameter | Type   | Required | Description                                 |
| --------- | ------ | -------- | ------------------------------------------- |
| `cwd`     | string | Yes      | Working directory where files were uploaded |

**Success response (200):** File content with appropriate MIME type.

**Error responses:**

- `400` — Missing `cwd` query parameter
- `403` — `cwd` is outside the configured directory boundary, or resolved path escapes upload directory
- `404` — File not found in the upload directory
- `500` — Internal server error

**Security:**

- `path.basename()` strips directory components from the filename parameter
- Resolved path is validated to stay within `{cwd}/.dork/.temp/uploads/`
- Directory boundary validation via `validateBoundary(cwd)`

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

## MCP Server

The DorkOS server embeds a standards-compliant MCP server at `/mcp` using Streamable HTTP transport. External agents (Claude Code, Cursor, Windsurf, custom Agent SDK apps) can connect and use all DorkOS tools.

The MCP endpoint is a protocol endpoint, not a REST API. It speaks JSON-RPC and is mounted at `/mcp` (not under `/api/`).

### Endpoint

| Method | Path   | Description                                          |
| ------ | ------ | ---------------------------------------------------- |
| POST   | `/mcp` | JSON-RPC requests (tool calls, initialize, etc.)     |
| GET    | `/mcp` | Returns 405 (stateless mode, no SSE)                 |
| DELETE | `/mcp` | Returns 405 (stateless mode, no session termination) |

The server operates in **stateless mode** — each POST request creates a fresh transport. There are no persistent sessions or SSE streams on the MCP endpoint.

### Authentication

Optional API key authentication via the `MCP_API_KEY` environment variable. When set, all requests must include:

```
Authorization: Bearer <MCP_API_KEY>
```

When `MCP_API_KEY` is not set, authentication is disabled (localhost-only access assumed). Generate a key with `openssl rand -hex 32`.

### Origin Validation

The MCP endpoint validates the `Origin` header to prevent DNS rebinding attacks, as required by the MCP specification. Non-browser clients (curl, Claude Code CLI, Agent SDK apps) do not send an `Origin` header and pass through. Browser-based requests must originate from `localhost:{DORKOS_PORT}`, `127.0.0.1:{DORKOS_PORT}`, or the active tunnel URL.

### Middleware Chain

Requests to `/mcp` pass through this middleware chain in order:

1. `validateMcpOrigin` — DNS rebinding protection (checks `Origin` header)
2. `mcpApiKeyAuth` — API key authentication (checks `Authorization` header)
3. `mcpRouter` — Streamable HTTP transport handler

### Available Tools

All DorkOS tools are registered on the external MCP server: core tools (ping, server info, session count, agent identity), Pulse scheduling tools, Relay messaging tools, adapter management tools, binding tools, trace/metrics tools, and Mesh discovery tools. Feature-guarded tools return descriptive errors when their service is disabled rather than being omitted from the tool list.

### Client Configuration

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:6242/mcp"
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
      "url": "http://localhost:6242/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

Via ngrok tunnel:

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

**Cursor / Windsurf:** Add an MCP server in settings with URL `http://localhost:6242/mcp` and type `http`. If using an API key, configure the `Authorization: Bearer <key>` header in the MCP server settings.

## A2A Gateway

The A2A gateway implements Google's Agent-to-Agent protocol, exposing DorkOS agents to external A2A-compatible clients. Feature-flag gated via `DORKOS_A2A_ENABLED` (requires `DORKOS_RELAY_ENABLED=true`).

Like the MCP endpoint, A2A is a protocol endpoint — it speaks JSON-RPC, not REST.

### Authentication

Same as MCP: optional `MCP_API_KEY` via `Authorization: Bearer <key>`. When `MCP_API_KEY` is not set, authentication is disabled.

### GET /.well-known/agent.json

Fleet-level Agent Card describing all registered DorkOS agents as a single A2A-compatible agent. This is the standard A2A discovery endpoint.

**Responses:**

- `200` - A2A Agent Card (JSON) with agent name, description, URL, and supported capabilities

### GET /a2a/agents/:id/card

Per-agent Agent Card for a specific registered agent.

**Path parameters:**

| Parameter | Type   | Description                     |
| --------- | ------ | ------------------------------- |
| `id`      | string | Agent ID from the Mesh registry |

**Responses:**

- `200` - A2A Agent Card (JSON) for the specified agent
- `404` - Agent not found in the Mesh registry

### POST /a2a

JSON-RPC 2.0 endpoint for A2A protocol messages. Supports the standard A2A methods:

| Method           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `message/send`   | Send a message and receive a complete response |
| `message/stream` | Send a message and stream the response via SSE |
| `tasks/get`      | Get the current state of a task                |
| `tasks/cancel`   | Cancel an in-progress task                     |

**Request body:** JSON-RPC 2.0 envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "Run the tests" }]
    }
  }
}
```

**Responses:**

- `200` - JSON-RPC 2.0 response (for `message/send`, `tasks/get`, `tasks/cancel`)
- `200` - SSE stream (for `message/stream`, `Content-Type: text/event-stream`)
- `400` - Invalid JSON-RPC request
- `404` - Unknown method
