# API Reference

## Interactive Docs

Start the server and visit:

- **Scalar UI**: [http://localhost:6942/api/docs](http://localhost:6942/api/docs) - interactive API explorer
- **Raw spec**: [http://localhost:6942/api/openapi.json](http://localhost:6942/api/openapi.json) - OpenAPI 3.1 JSON

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

The `POST /api/sessions/:id/messages` endpoint returns a `text/event-stream` response. Each SSE message follows the format:

```
event: message
data: {"type":"text_delta","data":{"text":"Hello"}}

```

Event types are documented in the `StreamEventType` enum in the OpenAPI spec. The Scalar UI describes the event format but cannot render live SSE streams.

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
