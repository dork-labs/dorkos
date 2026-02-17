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
