# Tasks: Relay Server & Client Integration

**Spec:** 51
**Last Decompose:** 2026-02-24
**Total Tasks:** 14
**Phases:** 5

---

## Phase 1: Server Foundation (6 tasks)

### Task 1.1: Create relay-state.ts feature flag module

**Subject:** [relay-server-client-integration] [P1] Create relay-state.ts feature flag module
**Active Form:** Creating relay-state.ts feature flag module
**Dependencies:** None (starter task)

Create `apps/server/src/services/relay-state.ts` as an exact mirror of `pulse-state.ts`:

```typescript
/**
 * Lightweight relay feature state registry.
 *
 * Holds the runtime enabled/disabled state of the Relay message bus so that
 * the config route can report it without a circular dependency on index.ts.
 * Set once during server startup by `index.ts` when RelayCore is initialized.
 *
 * @module services/relay-state
 */

/** Mutable Relay runtime state shared across the server process. */
const state = {
  enabled: false,
};

/**
 * Mark the Relay message bus as enabled.
 *
 * Called once from `index.ts` after `RelayCore` is successfully created.
 */
export function setRelayEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

/**
 * Return whether the Relay message bus is currently enabled.
 *
 * Consumed by the config route to populate `relay.enabled` in the GET response.
 */
export function isRelayEnabled(): boolean {
  return state.enabled;
}
```

**Acceptance Criteria:**

- File exists at `apps/server/src/services/relay-state.ts`
- Exports `setRelayEnabled(boolean): void` and `isRelayEnabled(): boolean`
- Follows exact same pattern as `pulse-state.ts` (TSDoc, const state object, getter/setter)
- TypeScript compiles without errors

---

### Task 1.2: Add relay config to config-schema.ts and turbo.json

**Subject:** [relay-server-client-integration] [P1] Add relay config to config-schema.ts and turbo.json
**Active Form:** Adding relay config to shared schemas and turbo.json
**Dependencies:** None (starter task)

**Part A: Update `packages/shared/src/config-schema.ts`**

Add a `relay` section to `UserConfigSchema`, placed after the `scheduler` section:

```typescript
relay: z
  .object({
    enabled: z.boolean().default(false),
    dataDir: z.string().nullable().default(null),
  })
  .default(() => ({
    enabled: false,
    dataDir: null,
  })),
```

This follows the exact same pattern as the `scheduler` config section (boolean `enabled` + nullable config fields with defaults).

**Part B: Update `turbo.json`**

Add `"DORKOS_RELAY_ENABLED"` to the `globalPassThroughEnv` array, placed after `"DORKOS_PULSE_ENABLED"`:

```json
"globalPassThroughEnv": [
    "DORKOS_PORT",
    "DORKOS_DEFAULT_CWD",
    "DORKOS_BOUNDARY",
    "DORKOS_LOG_LEVEL",
    "DORK_HOME",
    "DORKOS_PULSE_ENABLED",
    "DORKOS_RELAY_ENABLED",
    "TUNNEL_ENABLED",
    "TUNNEL_PORT",
    "TUNNEL_AUTH",
    "TUNNEL_DOMAIN",
    "NGROK_AUTHTOKEN"
  ],
```

**Acceptance Criteria:**

- `UserConfigSchema` includes `relay.enabled` (boolean, default false) and `relay.dataDir` (nullable string, default null)
- `USER_CONFIG_DEFAULTS` (from `UserConfigSchema.parse({ version: 1 })`) includes the relay defaults
- `turbo.json` `globalPassThroughEnv` includes `"DORKOS_RELAY_ENABLED"`
- TypeScript compiles and `UserConfig` type includes relay field
- Existing tests still pass

---

### Task 1.3: Add relay Zod schemas for HTTP API

**Subject:** [relay-server-client-integration] [P1] Add relay HTTP API Zod schemas to relay-schemas.ts
**Active Form:** Adding relay HTTP API Zod schemas
**Dependencies:** None (starter task)

Add the following 4 request/query schemas to `packages/shared/src/relay-schemas.ts` (after the existing `RelayAccessRuleSchema`):

```typescript
// === HTTP API Schemas ===

export const SendMessageRequestSchema = z
  .object({
    subject: z.string().min(1),
    payload: z.unknown(),
    from: z.string().min(1),
    replyTo: z.string().optional(),
    budget: z
      .object({
        maxHops: z.number().int().min(1).optional(),
        ttl: z.number().int().optional(),
        callBudgetRemaining: z.number().int().min(0).optional(),
      })
      .optional(),
  })
  .openapi('SendMessageRequest');

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const MessageListQuerySchema = z
  .object({
    subject: z.string().optional(),
    status: z.enum(['new', 'cur', 'failed']).optional(),
    from: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('MessageListQuery');

export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;

export const InboxQuerySchema = z
  .object({
    status: z.enum(['new', 'cur', 'failed']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('InboxQuery');

export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const EndpointRegistrationSchema = z
  .object({
    subject: z.string().min(1),
    description: z.string().optional(),
  })
  .openapi('EndpointRegistration');

export type EndpointRegistration = z.infer<typeof EndpointRegistrationSchema>;
```

**Acceptance Criteria:**

- All 4 schemas added to `packages/shared/src/relay-schemas.ts`
- Each schema has `.openapi()` metadata for OpenAPI generation
- Each schema exports a corresponding TypeScript type via `z.infer`
- `SendMessageRequestSchema` validates subject, payload, from, optional replyTo and budget
- `MessageListQuerySchema` uses `z.coerce.number()` for limit (query params come as strings)
- `InboxQuerySchema` uses `z.coerce.number()` for limit
- `EndpointRegistrationSchema` validates subject (min 1 char), optional description
- TypeScript compiles without errors

---

### Task 1.4: Create relay HTTP routes (non-SSE endpoints)

**Subject:** [relay-server-client-integration] [P1] Create relay HTTP routes with all non-SSE endpoints
**Active Form:** Creating relay HTTP route handlers
**Dependencies:** Task 1.1 (relay-state.ts), Task 1.3 (relay schemas)

Create `apps/server/src/routes/relay.ts` with a factory function `createRelayRouter(relayCore: RelayCore): Router` following the `pulse.ts` pattern. This task covers all endpoints except SSE stream (which is Phase 2).

**File: `apps/server/src/routes/relay.ts`**

```typescript
/**
 * Relay message bus routes — messaging, endpoints, dead letters, and metrics.
 *
 * @module routes/relay
 */
import { Router } from 'express';
import type { RelayCore } from '@dorkos/relay';
import {
  SendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
} from '@dorkos/shared/relay-schemas';

/**
 * Create the Relay router with messaging and endpoint management endpoints.
 *
 * @param relayCore - Initialized RelayCore instance
 */
export function createRelayRouter(relayCore: RelayCore): Router {
  const router = Router();

  // POST /messages — Send a message
  router.post('/messages', async (req, res) => {
    const result = SendMessageRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      const envelope = await relayCore.publish(result.data.subject, result.data.payload, {
        from: result.data.from,
        replyTo: result.data.replyTo,
        budget: result.data.budget,
      });
      return res.json({
        messageId: envelope.id,
        deliveredTo: envelope.deliveredTo ?? [],
        ...(envelope.warnings && { warnings: envelope.warnings }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publish failed';
      const code = (err as any)?.code ?? 'PUBLISH_FAILED';
      return res.status(422).json({ error: message, code });
    }
  });

  // GET /messages — List messages with optional filters
  router.get('/messages', async (req, res) => {
    const result = MessageListQuerySchema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { subject, status, from, cursor, limit } = result.data;
    const messages = await relayCore.listMessages({ subject, status, from, cursor, limit });
    return res.json(messages);
  });

  // GET /messages/:id — Get a single message
  router.get('/messages/:id', async (req, res) => {
    const message = await relayCore.getMessage(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    return res.json(message);
  });

  // GET /endpoints — List registered endpoints
  router.get('/endpoints', async (_req, res) => {
    const endpoints = await relayCore.listEndpoints();
    return res.json(endpoints);
  });

  // POST /endpoints — Register an endpoint
  router.post('/endpoints', async (req, res) => {
    const result = EndpointRegistrationSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const endpoint = await relayCore.registerEndpoint(result.data.subject, result.data.description);
    return res.status(201).json(endpoint);
  });

  // DELETE /endpoints/:subject — Unregister an endpoint
  router.delete('/endpoints/:subject', async (req, res) => {
    const removed = await relayCore.unregisterEndpoint(req.params.subject);
    if (!removed) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
    return res.json({ success: true });
  });

  // GET /endpoints/:subject/inbox — Read endpoint inbox
  router.get('/endpoints/:subject/inbox', async (req, res) => {
    const result = InboxQuerySchema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { status, cursor, limit } = result.data;
    try {
      const messages = await relayCore.readInbox(req.params.subject, { status, cursor, limit });
      return res.json(messages);
    } catch (err) {
      if ((err as any)?.code === 'ENDPOINT_NOT_FOUND') {
        return res.status(404).json({ error: 'Endpoint not found' });
      }
      throw err;
    }
  });

  // GET /dead-letters — List dead letter queue
  router.get('/dead-letters', async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const deadLetters = await relayCore.listDeadLetters({ limit });
    return res.json(deadLetters);
  });

  // GET /metrics — System metrics
  router.get('/metrics', async (_req, res) => {
    const metrics = await relayCore.getMetrics();
    return res.json(metrics);
  });

  return router;
}
```

**Endpoints to implement (9 non-SSE):**

| Method   | Path                        | Description        | Validation Schema            |
| -------- | --------------------------- | ------------------ | ---------------------------- |
| `POST`   | `/messages`                 | Send a message     | `SendMessageRequestSchema`   |
| `GET`    | `/messages`                 | List messages      | `MessageListQuerySchema`     |
| `GET`    | `/messages/:id`             | Get single message | —                            |
| `GET`    | `/endpoints`                | List endpoints     | —                            |
| `POST`   | `/endpoints`                | Register endpoint  | `EndpointRegistrationSchema` |
| `DELETE` | `/endpoints/:subject`       | Unregister         | —                            |
| `GET`    | `/endpoints/:subject/inbox` | Read inbox         | `InboxQuerySchema`           |
| `GET`    | `/dead-letters`             | List DLQ           | query `limit`                |
| `GET`    | `/metrics`                  | System metrics     | —                            |

**Acceptance Criteria:**

- File exists at `apps/server/src/routes/relay.ts`
- Exports `createRelayRouter(relayCore: RelayCore): Router`
- All 9 non-SSE endpoints implemented
- POST /messages validates with `SendMessageRequestSchema.safeParse()`, returns `{ messageId, deliveredTo, warnings? }`
- GET /messages validates query with `MessageListQuerySchema.safeParse()`, supports cursor pagination
- GET /messages/:id returns envelope or 404
- GET /endpoints returns endpoint list
- POST /endpoints validates with `EndpointRegistrationSchema.safeParse()`, returns 201
- DELETE /endpoints/:subject returns `{ success: true }` or 404
- GET /endpoints/:subject/inbox validates with `InboxQuerySchema.safeParse()`, returns messages or 404
- GET /dead-letters supports `limit` query param (default 50)
- GET /metrics returns relay system metrics
- All routes use try/catch for error handling with consistent error response shapes
- TypeScript compiles without errors

---

### Task 1.5: Add relay initialization to server index.ts and config route

**Subject:** [relay-server-client-integration] [P1] Add relay initialization to index.ts and config route
**Active Form:** Wiring relay initialization into server startup
**Dependencies:** Task 1.1 (relay-state.ts), Task 1.2 (config-schema), Task 1.4 (relay routes)

**Part A: Update `apps/server/src/index.ts`**

Add relay initialization after the Pulse initialization block (around line 51). The pattern mirrors Pulse exactly:

1. Add imports at the top:

```typescript
import { RelayCore } from '@dorkos/relay';
import { createRelayRouter } from './routes/relay.js';
import { setRelayEnabled } from './services/relay-state.js';
```

2. After the `pulseStore` initialization block (after line 51), add:

```typescript
// Initialize Relay if enabled
const relayConfig = configManager.get('relay') as { enabled: boolean; dataDir?: string | null };
const relayEnabled = process.env.DORKOS_RELAY_ENABLED === 'true' || relayConfig?.enabled;

let relayCore: RelayCore | undefined;
if (relayEnabled) {
  const dorkHome = process.env.DORK_HOME || path.join(os.homedir(), '.dork');
  const dataDir = relayConfig?.dataDir ?? path.join(dorkHome, 'relay');
  relayCore = new RelayCore({ dataDir });
  // Register system endpoint for console/UI
  await relayCore.registerEndpoint('relay.system.console');
  logger.info('[Relay] RelayCore initialized');
}
```

3. Update the `createDorkOsToolServer` call to include relayCore:

```typescript
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? process.cwd(),
  ...(pulseStore && { pulseStore }),
  ...(relayCore && { relayCore }),
});
```

4. After the Pulse route mounting block, add:

```typescript
// Mount Relay routes if enabled
if (relayEnabled && relayCore) {
  app.use('/api/relay', createRelayRouter(relayCore));
  setRelayEnabled(true);
  logger.info('[Relay] Routes mounted');
}
```

5. In the `shutdown()` function, add relay cleanup before `process.exit(0)`:

```typescript
if (relayCore) {
  await relayCore.close();
}
```

6. Add `relayCore` to the global shutdown references at the top of the file.

**Part B: Update `apps/server/src/routes/config.ts`**

1. Add import:

```typescript
import { isRelayEnabled } from '../services/relay-state.js';
```

2. In the GET handler (around line 88-107), add relay status to the response JSON alongside the existing `pulse` field:

```typescript
relay: {
  enabled: isRelayEnabled(),
},
```

**Acceptance Criteria:**

- Server initializes `RelayCore` when `DORKOS_RELAY_ENABLED=true` or `relay.enabled` is true in config
- `relayCore` is passed to `createDorkOsToolServer` when enabled
- Relay routes are mounted at `/api/relay` when enabled
- `setRelayEnabled(true)` is called after successful initialization
- Config GET endpoint includes `relay: { enabled: boolean }` in response
- Graceful shutdown calls `relayCore.close()` when relay was enabled
- System endpoint `relay.system.console` is registered on startup
- Server still starts correctly when relay is disabled (default)
- Existing Pulse functionality is unaffected

---

### Task 1.6: Write server relay route tests

**Subject:** [relay-server-client-integration] [P1] Write server relay route tests
**Active Form:** Writing relay route unit tests
**Dependencies:** Task 1.4 (relay routes)

Create `apps/server/src/routes/__tests__/relay.test.ts` with comprehensive route tests using a mock RelayCore instance.

**Test file structure:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRelayRouter } from '../relay.js';

// Mock RelayCore
function createMockRelayCore() {
  return {
    publish: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    listEndpoints: vi.fn(),
    registerEndpoint: vi.fn(),
    unregisterEndpoint: vi.fn(),
    readInbox: vi.fn(),
    listDeadLetters: vi.fn(),
    getMetrics: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  };
}

describe('Relay Routes', () => {
  let app: express.Express;
  let mockRelay: ReturnType<typeof createMockRelayCore>;

  beforeEach(() => {
    mockRelay = createMockRelayCore();
    app = express();
    app.use(express.json());
    app.use('/api/relay', createRelayRouter(mockRelay as any));
  });

  describe('POST /api/relay/messages', () => {
    it('sends a message with valid payload', async () => {
      mockRelay.publish.mockResolvedValue({
        id: 'msg-01',
        deliveredTo: ['relay.agent.backend'],
      });

      const res = await request(app)
        .post('/api/relay/messages')
        .send({
          subject: 'relay.agent.backend',
          payload: { text: 'hello' },
          from: 'relay.agent.frontend',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('messageId', 'msg-01');
      expect(res.body.deliveredTo).toEqual(['relay.agent.backend']);
    });

    it('returns 400 for invalid subject (empty)', async () => {
      const res = await request(app)
        .post('/api/relay/messages')
        .send({ subject: '', payload: {}, from: 'test' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error', 'Validation failed');
    });

    it('returns 400 for missing from field', async () => {
      const res = await request(app)
        .post('/api/relay/messages')
        .send({ subject: 'test.subject', payload: {} });

      expect(res.status).toBe(400);
    });

    it('returns 422 when publish throws an error', async () => {
      mockRelay.publish.mockRejectedValue(
        Object.assign(new Error('Access denied'), { code: 'ACCESS_DENIED' })
      );

      const res = await request(app)
        .post('/api/relay/messages')
        .send({ subject: 'blocked.subject', payload: {}, from: 'test' });

      expect(res.status).toBe(422);
      expect(res.body).toHaveProperty('code', 'ACCESS_DENIED');
    });
  });

  describe('GET /api/relay/messages', () => {
    it('lists messages with default params', async () => {
      mockRelay.listMessages.mockResolvedValue({ messages: [], nextCursor: null });

      const res = await request(app).get('/api/relay/messages');

      expect(res.status).toBe(200);
      expect(mockRelay.listMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });

    it('passes filter params to listMessages', async () => {
      mockRelay.listMessages.mockResolvedValue({ messages: [], nextCursor: null });

      await request(app).get('/api/relay/messages?subject=relay.agent.*&status=new&limit=10');

      expect(mockRelay.listMessages).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'relay.agent.*', status: 'new', limit: 10 })
      );
    });
  });

  describe('GET /api/relay/messages/:id', () => {
    it('returns a message when found', async () => {
      const envelope = { id: 'msg-01', subject: 'test', from: 'sender' };
      mockRelay.getMessage.mockResolvedValue(envelope);

      const res = await request(app).get('/api/relay/messages/msg-01');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(envelope);
    });

    it('returns 404 when not found', async () => {
      mockRelay.getMessage.mockResolvedValue(null);

      const res = await request(app).get('/api/relay/messages/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/relay/endpoints', () => {
    it('returns registered endpoints', async () => {
      const endpoints = [{ subject: 'relay.agent.backend', messageCount: 5 }];
      mockRelay.listEndpoints.mockResolvedValue(endpoints);

      const res = await request(app).get('/api/relay/endpoints');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(endpoints);
    });
  });

  describe('POST /api/relay/endpoints', () => {
    it('registers a new endpoint', async () => {
      const endpoint = { subject: 'relay.agent.new', messageCount: 0 };
      mockRelay.registerEndpoint.mockResolvedValue(endpoint);

      const res = await request(app)
        .post('/api/relay/endpoints')
        .send({ subject: 'relay.agent.new', description: 'New agent' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(endpoint);
    });

    it('returns 400 for empty subject', async () => {
      const res = await request(app).post('/api/relay/endpoints').send({ subject: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/relay/endpoints/:subject', () => {
    it('removes an endpoint', async () => {
      mockRelay.unregisterEndpoint.mockResolvedValue(true);

      const res = await request(app).delete('/api/relay/endpoints/relay.agent.old');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 404 for non-existent endpoint', async () => {
      mockRelay.unregisterEndpoint.mockResolvedValue(false);

      const res = await request(app).delete('/api/relay/endpoints/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/relay/endpoints/:subject/inbox', () => {
    it('returns inbox messages', async () => {
      mockRelay.readInbox.mockResolvedValue({ messages: [], nextCursor: null });

      const res = await request(app).get('/api/relay/endpoints/relay.agent.backend/inbox');

      expect(res.status).toBe(200);
    });

    it('returns 404 for unknown endpoint', async () => {
      mockRelay.readInbox.mockRejectedValue(
        Object.assign(new Error('Not found'), { code: 'ENDPOINT_NOT_FOUND' })
      );

      const res = await request(app).get('/api/relay/endpoints/unknown/inbox');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/relay/dead-letters', () => {
    it('returns dead letter entries', async () => {
      mockRelay.listDeadLetters.mockResolvedValue([]);

      const res = await request(app).get('/api/relay/dead-letters');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/relay/metrics', () => {
    it('returns system metrics', async () => {
      const metrics = { totalMessages: 42, totalEndpoints: 3, deadLetters: 1 };
      mockRelay.getMetrics.mockResolvedValue(metrics);

      const res = await request(app).get('/api/relay/metrics');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(metrics);
    });
  });
});
```

**Test scenarios:**

- POST /messages with valid payload -> 200, returns messageId
- POST /messages with invalid subject (empty string) -> 400, Zod error details
- POST /messages with missing from -> 400
- POST /messages when publish throws (ACCESS_DENIED) -> 422 with error code
- GET /messages with default params -> passes limit: 50
- GET /messages with filters -> passes subject, status, limit
- GET /messages/:id found -> 200 with envelope
- GET /messages/:id not found -> 404
- GET /endpoints -> returns list
- POST /endpoints with valid subject -> 201
- POST /endpoints with empty subject -> 400
- DELETE /endpoints/:subject existing -> 200 `{ success: true }`
- DELETE /endpoints/:subject non-existent -> 404
- GET /endpoints/:subject/inbox -> returns messages
- GET /endpoints/:subject/inbox for unknown endpoint -> 404
- GET /dead-letters -> returns entries
- GET /metrics -> returns metrics object

**Acceptance Criteria:**

- Test file at `apps/server/src/routes/__tests__/relay.test.ts`
- Uses mock RelayCore with all methods stubbed via `vi.fn()`
- Covers all 9 non-SSE endpoints with at least success and error cases
- Validates Zod validation behavior (400 on bad input)
- Validates error code propagation (422 for publish errors)
- All tests pass with `npx vitest run apps/server/src/routes/__tests__/relay.test.ts`

---

## Phase 2: MCP Tools & SSE (2 tasks)

### Task 2.1: Add 4 relay MCP tools to mcp-tool-server.ts

**Subject:** [relay-server-client-integration] [P2] Add 4 relay MCP tools to mcp-tool-server.ts
**Active Form:** Adding relay MCP tools to tool server
**Dependencies:** Task 1.5 (index.ts initialization — relayCore in McpToolDeps)

Update `apps/server/src/services/mcp-tool-server.ts`:

1. **Add RelayCore to McpToolDeps interface:**

```typescript
import type { RelayCore } from '@dorkos/relay';

export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore;
  relayCore?: RelayCore; // NEW
}
```

2. **Add `requireRelay` guard (same pattern as `requirePulse`):**

```typescript
/** Guard that returns an error response when Relay is disabled. */
function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}
```

3. **Add 4 relay tool handler factories:**

```typescript
/** Send a message to a Relay subject. */
export function createRelaySendHandler(deps: McpToolDeps) {
  return async (args: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const envelope = await deps.relayCore!.publish(args.subject, args.payload, {
        from: args.from,
        replyTo: args.replyTo,
        budget: args.budget,
      });
      return jsonContent({ messageId: envelope.id, deliveredTo: envelope.deliveredTo ?? [] });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Publish failed';
      const code = (e as any)?.code ?? 'PUBLISH_FAILED';
      return jsonContent(
        { error: message, code, hint: 'Check subject, access rules, and budget.' },
        true
      );
    }
  };
}

/** Read inbox messages for a Relay endpoint. */
export function createRelayInboxHandler(deps: McpToolDeps) {
  return async (args: { endpoint_subject: string; limit?: number; status?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const result = await deps.relayCore!.readInbox(args.endpoint_subject, {
        limit: args.limit ?? 20,
        status: args.status as 'new' | 'cur' | 'failed' | undefined,
      });
      return jsonContent({ messages: result.messages, count: result.messages.length });
    } catch (e) {
      if ((e as any)?.code === 'ENDPOINT_NOT_FOUND') {
        return jsonContent(
          { error: `Endpoint '${args.endpoint_subject}' not found`, code: 'ENDPOINT_NOT_FOUND' },
          true
        );
      }
      return jsonContent({ error: e instanceof Error ? e.message : 'Inbox read failed' }, true);
    }
  };
}

/** List all registered Relay endpoints. */
export function createRelayListEndpointsHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireRelay(deps);
    if (err) return err;
    const endpoints = await deps.relayCore!.listEndpoints();
    return jsonContent({ endpoints, count: endpoints.length });
  };
}

/** Register a new Relay endpoint. */
export function createRelayRegisterEndpointHandler(deps: McpToolDeps) {
  return async (args: { subject: string; description?: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const endpoint = await deps.relayCore!.registerEndpoint(args.subject, args.description);
      return jsonContent({ endpoint });
    } catch (e) {
      return jsonContent(
        {
          error: e instanceof Error ? e.message : 'Registration failed',
          code: 'REGISTRATION_FAILED',
        },
        true
      );
    }
  };
}
```

4. **Register tools in `createDorkOsToolServer`:**

```typescript
const relayTools = [
  tool(
    'relay_send',
    'Send a message to a Relay subject. Messages are delivered to all matching endpoint subscriptions.',
    {
      subject: z
        .string()
        .describe('NATS-style subject to publish to (e.g., "relay.agent.backend")'),
      payload: z.unknown().describe('Message payload (any JSON-serializable data)'),
      from: z.string().describe('Sender endpoint subject (e.g., "relay.agent.frontend")'),
      replyTo: z.string().optional().describe('Subject to use for reply messages'),
      budget: z
        .object({
          maxHops: z.number().optional().describe('Maximum hop count (default 5)'),
          ttl: z.number().optional().describe('Time-to-live in milliseconds'),
          callBudgetRemaining: z.number().optional().describe('Remaining call budget'),
        })
        .optional()
        .describe('Optional budget constraints'),
    },
    createRelaySendHandler(deps)
  ),
  tool(
    'relay_inbox',
    'Read inbox messages for a Relay endpoint. Returns messages delivered to the specified subject.',
    {
      endpoint_subject: z.string().describe('Endpoint subject to read inbox for'),
      limit: z.number().optional().describe('Max messages to return (default 20)'),
      status: z.string().optional().describe('Filter by status: new, cur, or failed'),
    },
    createRelayInboxHandler(deps)
  ),
  tool(
    'relay_list_endpoints',
    'List all registered Relay endpoints with their subjects and message counts.',
    {},
    createRelayListEndpointsHandler(deps)
  ),
  tool(
    'relay_register_endpoint',
    'Register a new Relay endpoint for receiving messages. Idempotent — returns existing if already registered.',
    {
      subject: z.string().describe('NATS-style subject pattern for the endpoint'),
      description: z
        .string()
        .optional()
        .describe('Human-readable description of the endpoint purpose'),
    },
    createRelayRegisterEndpointHandler(deps)
  ),
];

return createSdkMcpServer({
  name: 'dorkos',
  version: '1.0.0',
  tools: [
    // ... existing core tools ...
    ...pulseTools,
    ...relayTools,
  ],
});
```

**Error response structure for all relay tools:**

```json
{ "error": "Description", "code": "ERROR_CODE", "hint": "Optional guidance" }
```

Error codes: `RELAY_DISABLED`, `ACCESS_DENIED`, `BUDGET_EXCEEDED`, `INVALID_SUBJECT`, `ENDPOINT_NOT_FOUND`, `PUBLISH_FAILED`, `REGISTRATION_FAILED`.

**Acceptance Criteria:**

- `McpToolDeps` interface includes optional `relayCore?: RelayCore`
- `requireRelay()` guard returns `RELAY_DISABLED` error when relay is undefined
- 4 tools registered: `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`
- `relay_send` calls `relayCore.publish()`, returns `{ messageId, deliveredTo }`
- `relay_inbox` calls `relayCore.readInbox()`, returns `{ messages, count }`
- `relay_list_endpoints` calls `relayCore.listEndpoints()`, returns `{ endpoints, count }`
- `relay_register_endpoint` calls `relayCore.registerEndpoint()`, returns `{ endpoint }`
- All tools return `isError: true` with structured error payloads on failure
- All tool Zod schemas have `.describe()` for MCP tool parameter docs
- Tools are added to `relayTools` array and spread into the `tools` list in `createSdkMcpServer`
- TypeScript compiles without errors

**Tests: Create `apps/server/src/services/__tests__/mcp-relay-tools.test.ts`**

Test scenarios:

- `relay_send` with `relayCore` undefined -> returns error with `RELAY_DISABLED` code
- `relay_send` with valid args -> calls `relayCore.publish()`, returns messageId
- `relay_send` with access denied error -> returns error with `ACCESS_DENIED` code
- `relay_inbox` with valid endpoint -> returns messages array
- `relay_inbox` with non-existent endpoint -> returns `ENDPOINT_NOT_FOUND` error
- `relay_list_endpoints` -> returns endpoints and count
- `relay_register_endpoint` with valid subject -> returns endpoint info
- `relay_register_endpoint` when relay disabled -> returns `RELAY_DISABLED`

---

### Task 2.2: Add SSE stream endpoint to relay routes

**Subject:** [relay-server-client-integration] [P2] Add SSE stream endpoint to relay routes
**Active Form:** Adding SSE stream endpoint for real-time relay events
**Dependencies:** Task 1.4 (relay routes)

Add the SSE stream endpoint to `apps/server/src/routes/relay.ts`. This endpoint allows clients to subscribe to real-time relay message events with optional server-side subject filtering.

**Add import:**

```typescript
import { initSSEStream, sendSSEEvent } from '../services/stream-adapter.js';
```

**Add route (before the `return router` statement):**

```typescript
// GET /stream — SSE event stream with optional subject filtering
router.get('/stream', (req, res) => {
  initSSEStream(res);

  // Send connected event
  sendSSEEvent(res, {
    type: 'relay_connected' as any,
    data: { timestamp: new Date().toISOString() },
  });

  // Subscribe to relay messages with optional subject filter
  const pattern = (req.query.subject as string) || '>';
  const unsub = relayCore.subscribe(pattern, (envelope) => {
    res.write(`id: ${envelope.id}\n`);
    sendSSEEvent(res, {
      type: 'relay_message' as any,
      data: envelope,
    });
  });

  // Keepalive every 15 seconds to prevent proxy disconnections
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    unsub();
    clearInterval(keepalive);
  });
});
```

**Key behaviors:**

- Uses `initSSEStream()` from `stream-adapter.ts` to set SSE headers
- Sends `relay_connected` event immediately on connection
- Accepts optional `?subject=pattern` query param for server-side filtering (default `>` matches all)
- Each message event includes the envelope `id` as the SSE event ID for client reconnection
- Sends SSE keepalive comments (`: keepalive\n\n`) every 15 seconds
- Cleans up subscription and keepalive on client disconnect

**Add SSE test to `apps/server/src/routes/__tests__/relay.test.ts`:**

```typescript
describe('GET /api/relay/stream', () => {
  it('establishes SSE connection and receives events', async () => {
    let subscribeCb: ((envelope: any) => void) | undefined;
    mockRelay.subscribe.mockImplementation((_pattern: string, cb: any) => {
      subscribeCb = cb;
      return () => {}; // unsub
    });

    const res = await request(app)
      .get('/api/relay/stream')
      .set('Accept', 'text/event-stream')
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // After receiving connected event, send a test message
          if (data.includes('relay_connected') && subscribeCb) {
            subscribeCb({ id: 'test-msg', subject: 'test', from: 'sender' });
            // Close the connection after receiving the message
            setTimeout(() => res.emit('end'), 50);
          }
        });
        res.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('relay_connected');
  });

  it('passes subject filter to subscribe', async () => {
    mockRelay.subscribe.mockImplementation(() => () => {});

    // Start request but don't wait for it (SSE never ends)
    const req = request(app).get('/api/relay/stream?subject=relay.agent.*');
    // Abort after a short delay
    setTimeout(() => req.abort(), 100);

    try {
      await req;
    } catch {
      /* aborted */
    }

    expect(mockRelay.subscribe).toHaveBeenCalledWith('relay.agent.*', expect.any(Function));
  });
});
```

**Acceptance Criteria:**

- SSE endpoint exists at `GET /api/relay/stream`
- Sets correct SSE headers via `initSSEStream()`
- Sends `relay_connected` event on initial connection
- Subscribes to relay messages via `relayCore.subscribe(pattern, callback)`
- Uses `?subject=` query param for filtering (default `>` matches all)
- Each SSE message includes envelope ID as SSE event ID
- Keepalive comment sent every 15 seconds
- Cleanup (unsub + clearInterval) on client disconnect
- SSE test verifies connection establishment and subject filtering

---

## Phase 3: Client Entity Hooks (1 task)

### Task 3.1: Create entities/relay/ with all domain hooks

**Subject:** [relay-server-client-integration] [P3] Create entities/relay/ with all domain hooks
**Active Form:** Creating client entity hooks for relay
**Dependencies:** Task 1.4 (relay routes — HTTP API to query), Task 2.2 (SSE stream endpoint)

Create the `apps/client/src/layers/entities/relay/` module with 5 hooks following the Pulse entity pattern.

**File: `apps/client/src/layers/entities/relay/index.ts`**

```typescript
/**
 * Relay entity — domain hooks for relay message and endpoint data fetching.
 *
 * @module entities/relay
 */
export { useRelayEnabled } from './model/use-relay-config';
export { useRelayMessages } from './model/use-relay-messages';
export { useRelayEndpoints } from './model/use-relay-endpoints';
export { useRelayMetrics } from './model/use-relay-metrics';
export { useRelayEventStream } from './model/use-relay-event-stream';
```

**File: `apps/client/src/layers/entities/relay/model/use-relay-config.ts`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Fetch server config and derive whether Relay messaging is enabled. */
export function useRelayEnabled(): boolean {
  const transport = useTransport();

  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  return data?.relay?.enabled ?? false;
}
```

**File: `apps/client/src/layers/entities/relay/model/use-relay-messages.ts`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

interface MessageFilters {
  subject?: string;
  status?: 'new' | 'cur' | 'failed';
  from?: string;
  cursor?: string;
  limit?: number;
}

/** Fetch relay messages with optional filters and cursor pagination. */
export function useRelayMessages(enabled: boolean, filters?: MessageFilters) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['relay', 'messages', filters],
    queryFn: () => transport.fetch('/api/relay/messages', { params: filters }),
    enabled,
    refetchInterval: 10_000, // Poll every 10s as fallback to SSE
  });
}
```

**File: `apps/client/src/layers/entities/relay/model/use-relay-endpoints.ts`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Fetch all registered relay endpoints. */
export function useRelayEndpoints(enabled: boolean) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['relay', 'endpoints'],
    queryFn: () => transport.fetch('/api/relay/endpoints'),
    enabled,
    staleTime: 30_000,
  });
}
```

**File: `apps/client/src/layers/entities/relay/model/use-relay-metrics.ts`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Fetch relay system metrics (total messages, endpoints, dead letters). */
export function useRelayMetrics(enabled: boolean) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['relay', 'metrics'],
    queryFn: () => transport.fetch('/api/relay/metrics'),
    enabled,
    staleTime: 30_000,
  });
}
```

**File: `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`**

```typescript
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Subscribe to relay SSE events and inject new messages into React Query cache.
 *
 * Creates an EventSource connection to `/api/relay/stream` with optional subject
 * pattern filtering. Incoming `relay_message` events are prepended to the messages
 * query cache for instant UI updates without refetching.
 *
 * @param enabled - Whether to connect (false disconnects)
 * @param pattern - Optional NATS-style subject pattern to filter events
 */
export function useRelayEventStream(enabled: boolean, pattern?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const params = pattern ? `?subject=${encodeURIComponent(pattern)}` : '';
    const source = new EventSource(`/api/relay/stream${params}`);

    source.addEventListener('relay_message', (e) => {
      const envelope = JSON.parse(e.data);
      // Inject into React Query cache for immediate UI update
      queryClient.setQueryData(['relay', 'messages'], (old: any) => {
        if (!old) return { messages: [envelope] };
        return { ...old, messages: [envelope, ...old.messages] };
      });
    });

    source.addEventListener('error', () => {
      // EventSource auto-reconnects; just log for debugging
      console.debug('[Relay SSE] Connection error, auto-reconnecting...');
    });

    return () => source.close();
  }, [enabled, pattern, queryClient]);
}
```

**Tests: Create `apps/client/src/layers/entities/relay/__tests__/use-relay-config.test.ts`**

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useRelayEnabled } from '../model/use-relay-config';

describe('useRelayEnabled', () => {
  it('returns false when config has relay disabled', async () => {
    const transport = createMockTransport();
    transport.getConfig = vi.fn().mockResolvedValue({ relay: { enabled: false } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useRelayEnabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('returns true when config has relay enabled', async () => {
    const transport = createMockTransport();
    transport.getConfig = vi.fn().mockResolvedValue({ relay: { enabled: true } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useRelayEnabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('defaults to false when config is not yet loaded', () => {
    const transport = createMockTransport();
    transport.getConfig = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useRelayEnabled(), { wrapper });
    expect(result.current).toBe(false);
  });
});
```

**Acceptance Criteria:**

- Module exists at `apps/client/src/layers/entities/relay/`
- Barrel `index.ts` exports all 5 hooks
- `useRelayEnabled()` queries `['config']` and returns `data?.relay?.enabled ?? false`
- `useRelayMessages(enabled, filters?)` queries `['relay', 'messages', filters]` with 10s poll interval
- `useRelayEndpoints(enabled)` queries `['relay', 'endpoints']` with 30s stale time
- `useRelayMetrics(enabled)` queries `['relay', 'metrics']` with 30s stale time
- `useRelayEventStream(enabled, pattern?)` creates EventSource to `/api/relay/stream`, injects events into query cache
- All hooks follow FSD layer rules (only import from `shared/`)
- Entity hook tests pass

---

## Phase 4: Client Feature UI (2 tasks)

### Task 4.1: Create features/relay/ with RelayPanel and sub-components

**Subject:** [relay-server-client-integration] [P4] Create features/relay/ with RelayPanel and sub-components
**Active Form:** Building relay feature UI components
**Dependencies:** Task 3.1 (entity hooks)

Create the `apps/client/src/layers/features/relay/` module with 5 components.

**File: `apps/client/src/layers/features/relay/index.ts`**

```typescript
/**
 * Relay feature — inter-agent messaging activity feed and endpoint management.
 *
 * @module features/relay
 */
export { RelayPanel } from './ui/RelayPanel';
```

**File: `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`**

Main panel with two tabs (Activity, Endpoints). Mirrors PulsePanel disabled/loading/active states:

```tsx
import { useState } from 'react';
import { Route } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/layers/shared/ui';
import {
  useRelayEnabled,
  useRelayMessages,
  useRelayEndpoints,
  useRelayEventStream,
} from '@/layers/entities/relay';
import { ActivityFeed } from './ActivityFeed';
import { EndpointList } from './EndpointList';

/** Main Relay panel — renders activity feed and endpoints or disabled/loading states. */
export function RelayPanel() {
  const relayEnabled = useRelayEnabled();
  const { data: messagesData, isLoading: messagesLoading } = useRelayMessages(relayEnabled);
  const { data: endpointsData, isLoading: endpointsLoading } = useRelayEndpoints(relayEnabled);
  useRelayEventStream(relayEnabled);

  const [activeTab, setActiveTab] = useState('activity');

  if (!relayEnabled) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Route className="text-muted-foreground/50 size-8" />
        <div>
          <p className="font-medium">Relay is not enabled</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Relay enables inter-agent messaging. Start DorkOS with DORKOS_RELAY_ENABLED=true to
            enable it.
          </p>
        </div>
        <code className="bg-muted mt-2 rounded-md px-3 py-1.5 font-mono text-sm">
          DORKOS_RELAY_ENABLED=true dorkos
        </code>
      </div>
    );
  }

  const isLoading = messagesLoading || endpointsLoading;

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="bg-muted size-2 animate-pulse rounded-full" />
              <div className="flex-1 space-y-1.5">
                <div className="bg-muted h-4 w-32 animate-pulse rounded" />
                <div className="bg-muted h-3 w-48 animate-pulse rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <div className="border-b px-4">
        <TabsList className="h-9">
          <TabsTrigger value="activity" className="text-xs">
            Activity
          </TabsTrigger>
          <TabsTrigger value="endpoints" className="text-xs">
            Endpoints
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="activity" className="mt-0">
        <ActivityFeed messages={messagesData?.messages ?? []} />
      </TabsContent>
      <TabsContent value="endpoints" className="mt-0">
        <EndpointList endpoints={endpointsData ?? []} />
      </TabsContent>
    </Tabs>
  );
}
```

**File: `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`**

Chronological message list with filtering:

```tsx
import { useState } from 'react';
import { MessageRow } from './MessageRow';

interface ActivityFeedProps {
  messages: any[];
}

/** Chronological message activity feed with expand-on-click and filtering. */
export function ActivityFeed({ messages }: ActivityFeedProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-muted-foreground text-sm">No messages yet</p>
        <p className="text-muted-foreground/70 text-xs">
          Messages will appear here when agents communicate via Relay.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {messages.map((msg) => (
        <MessageRow
          key={msg.id}
          message={msg}
          expanded={expandedId === msg.id}
          onToggleExpand={() => setExpandedId(expandedId === msg.id ? null : msg.id)}
        />
      ))}
    </div>
  );
}
```

**File: `apps/client/src/layers/features/relay/ui/MessageRow.tsx`**

Individual message card with compact/expanded views:

```tsx
import { Clock, Check, AlertTriangle, MailX } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';

interface MessageRowProps {
  message: any;
  expanded: boolean;
  onToggleExpand: () => void;
}

const STATUS_CONFIG = {
  new: { icon: Clock, className: 'text-muted-foreground' },
  cur: { icon: Check, className: 'text-muted-foreground' },
  failed: { icon: AlertTriangle, className: 'text-destructive' },
  dead_letter: { icon: MailX, className: 'text-amber-500' },
} as const;

/** Individual relay message row — compact view with expand-on-click for details. */
export function MessageRow({ message, expanded, onToggleExpand }: MessageRowProps) {
  const status = (message.status ?? 'new') as keyof typeof STATUS_CONFIG;
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;
  const StatusIcon = config.icon;
  const timeAgo = formatTimeAgo(message.createdAt);

  return (
    <button
      onClick={onToggleExpand}
      className="hover:bg-muted/50 w-full px-4 py-2.5 text-left transition-colors"
    >
      <div className="flex items-start gap-2">
        <StatusIcon className={cn('mt-0.5 size-3.5 shrink-0', config.className)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{message.subject}</span>
            <Badge variant="outline" className="text-2xs shrink-0">
              {status}
            </Badge>
          </div>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
            <span>from: {message.from}</span>
            <span>{timeAgo}</span>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="bg-muted/30 mt-2 rounded-md p-2 text-xs">
          <pre className="text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(message.payload, null, 2)}
          </pre>
          {message.budget && (
            <div className="text-muted-foreground/70 mt-1.5 border-t pt-1.5">
              Budget: hop {message.budget.hopCount}/{message.budget.maxHops}
              {message.budget.callBudgetRemaining != null &&
                ` | calls: ${message.budget.callBudgetRemaining}`}
            </div>
          )}
        </div>
      )}
    </button>
  );
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

**File: `apps/client/src/layers/features/relay/ui/EndpointList.tsx`**

List of registered endpoints:

```tsx
import { Route } from 'lucide-react';

interface EndpointListProps {
  endpoints: any[];
}

/** List of registered relay endpoints with subject patterns and message counts. */
export function EndpointList({ endpoints }: EndpointListProps) {
  if (endpoints.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-muted-foreground text-sm">No endpoints registered</p>
        <p className="text-muted-foreground/70 text-xs">
          Endpoints are registered by agents when they join the relay network.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {endpoints.map((ep) => (
        <div key={ep.subject} className="flex items-center gap-3 px-4 py-2.5">
          <Route className="text-muted-foreground/50 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{ep.subject}</p>
            {ep.description && (
              <p className="text-muted-foreground truncate text-xs">{ep.description}</p>
            )}
          </div>
          {ep.messageCount != null && (
            <span className="text-muted-foreground text-xs">{ep.messageCount} msgs</span>
          )}
        </div>
      ))}
    </div>
  );
}
```

**File: `apps/client/src/layers/features/relay/ui/InboxView.tsx`**

Messages for a selected endpoint (reuses MessageRow):

```tsx
import { useState } from 'react';
import { useRelayMessages } from '@/layers/entities/relay';
import { MessageRow } from './MessageRow';

interface InboxViewProps {
  endpointSubject: string;
  enabled: boolean;
}

/** Inbox view for a specific endpoint — reuses MessageRow for consistent display. */
export function InboxView({ endpointSubject, enabled }: InboxViewProps) {
  const { data, isLoading } = useRelayMessages(enabled, { subject: endpointSubject });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2].map((i) => (
          <div key={i} className="bg-muted h-12 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const messages = data?.messages ?? [];

  if (messages.length === 0) {
    return (
      <div className="text-muted-foreground p-8 text-center text-sm">
        No messages in inbox for {endpointSubject}
      </div>
    );
  }

  return (
    <div className="divide-y">
      {messages.map((msg: any) => (
        <MessageRow
          key={msg.id}
          message={msg}
          expanded={expandedId === msg.id}
          onToggleExpand={() => setExpandedId(expandedId === msg.id ? null : msg.id)}
        />
      ))}
    </div>
  );
}
```

**Status indicators used in MessageRow:**

| Status        | Icon            | Color class             |
| ------------- | --------------- | ----------------------- |
| `new`         | `Clock`         | `text-muted-foreground` |
| `cur`         | `Check`         | `text-muted-foreground` |
| `failed`      | `AlertTriangle` | `text-destructive`      |
| `dead_letter` | `MailX`         | `text-amber-500`        |

**Acceptance Criteria:**

- Module exists at `apps/client/src/layers/features/relay/`
- Barrel `index.ts` exports `RelayPanel`
- `RelayPanel` shows disabled state when `useRelayEnabled()` is false
- `RelayPanel` shows loading skeletons while data is fetching
- `RelayPanel` renders tabs (Activity + Endpoints) when enabled
- `ActivityFeed` renders messages chronologically with expand-on-click
- `MessageRow` shows compact view (subject, from, time, status badge) and expanded view (payload, budget)
- `EndpointList` shows endpoints with subject patterns and message counts
- `InboxView` shows messages for a specific endpoint
- All components follow FSD layer rules (import from entities/ and shared/ only)
- All status indicators use correct icons and colors per the spec table
- TypeScript compiles without errors

---

### Task 4.2: Integrate RelayPanel into SessionSidebar

**Subject:** [relay-server-client-integration] [P4] Integrate RelayPanel dialog into SessionSidebar
**Active Form:** Wiring relay panel into session sidebar
**Dependencies:** Task 4.1 (RelayPanel components), Task 3.1 (useRelayEnabled hook)

Modify `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` to wire the existing Route icon button to open a RelayPanel dialog.

**Changes required:**

1. **Add imports:**

```typescript
import { RelayPanel } from '@/layers/features/relay';
import { useRelayEnabled } from '@/layers/entities/relay';
```

2. **Add state and hook in `SessionSidebar` component body:**

```typescript
const relayEnabled = useRelayEnabled();
const [relayOpen, setRelayOpen] = useState(false);
```

3. **Replace the existing Route button HoverCard** (lines 233-245 of current file) with a click-to-open button:

```tsx
<button
  onClick={() => setRelayOpen(true)}
  className={cn(
    'rounded-md p-1 transition-colors duration-150 max-md:p-2',
    relayEnabled
      ? 'text-muted-foreground/50 hover:text-muted-foreground'
      : 'text-muted-foreground/25 hover:text-muted-foreground/40'
  )}
  aria-label="Relay messaging"
>
  <Route className="size-(--size-icon-sm)" />
</button>
```

4. **Add the RelayPanel dialog** (after the existing Pulse dialog at lines 300-314):

```tsx
<ResponsiveDialog open={relayOpen} onOpenChange={setRelayOpen}>
  <ResponsiveDialogContent className="max-w-2xl gap-0 p-0">
    <ResponsiveDialogHeader className="border-b px-4 py-3">
      <ResponsiveDialogTitle className="text-sm font-medium">Relay</ResponsiveDialogTitle>
      <ResponsiveDialogDescription className="sr-only">
        Inter-agent messaging activity and endpoints
      </ResponsiveDialogDescription>
    </ResponsiveDialogHeader>
    <div className="overflow-y-auto">
      <RelayPanel />
    </div>
  </ResponsiveDialogContent>
</ResponsiveDialog>
```

**Key behavior changes:**

- Route icon button now clickable (was just a HoverCard display)
- Click opens a ResponsiveDialog containing RelayPanel
- Button styling changes based on `relayEnabled` state (brighter when enabled, dimmed when disabled)
- Dialog follows exact same pattern as the Pulse dialog
- Removes the HoverCard wrapper from the Route button (no longer needed since the dialog has a title)

**Component tests: Update `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx`** (if it exists) or create a focused test:

Test scenarios:

- Route button is rendered with correct aria-label "Relay messaging"
- Route button has dimmed styling when relay is disabled
- Route button has normal styling when relay is enabled
- Clicking Route button opens dialog containing RelayPanel
- RelayPanel dialog has correct title "Relay"

**Acceptance Criteria:**

- Route icon button is clickable and opens RelayPanel dialog
- Button appearance reflects relay enabled/disabled state
- Dialog uses ResponsiveDialog with same structure as Pulse dialog
- Dialog header shows "Relay" title, sr-only description
- RelayPanel is rendered inside the dialog
- HoverCard wrapper is removed from Route button
- `useRelayEnabled` hook imported from `@/layers/entities/relay`
- `RelayPanel` imported from `@/layers/features/relay`
- FSD layer rules respected (features can import from other features' UI for composition)
- Existing sidebar functionality (Pulse, settings, theme) unaffected

---

## Phase 5: Documentation & Polish (3 tasks)

### Task 5.1: Update AGENTS.md with relay documentation

**Subject:** [relay-server-client-integration] [P5] Update AGENTS.md with relay documentation
**Active Form:** Updating AGENTS.md with relay integration details
**Dependencies:** Task 1.1, 1.4, 1.5, 2.1, 3.1, 4.1 (all implementation tasks)

Update `AGENTS.md` with relay-related additions. Each change is additive — no existing content is removed.

**Changes to make:**

1. **Route groups list** (in the Server section, around the "Nine route groups" description):
   - Change "Nine route groups" to "Ten route groups"
   - Add after `routes/pulse.ts` entry:

   ```
   - **`routes/relay.ts`** - Relay message bus CRUD (POST/GET messages, GET/POST/DELETE endpoints, GET inbox, GET dead-letters, GET metrics, GET SSE stream). Factory function `createRelayRouter(relayCore)`.
   ```

2. **Services list** (in the "Twenty-two services" section):
   - Increment the count to "Twenty-three services (+ 1 lib utility)"
   - Add entry after `scheduler-service.ts`:

   ```
   - **`services/relay-state.ts`** - Lightweight relay feature state registry. Holds runtime enabled/disabled state so config route can report it without circular dependency on index.ts. Mirrors `pulse-state.ts` pattern.
   ```

3. **MCP tool server description** — Update the `mcp-tool-server.ts` description to mention relay tools:
   - Add to the existing description: "Relay tools: `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`. Relay tools require `relayCore` in `McpToolDeps`."

4. **FSD Layers table** (in the Client section):
   - Add to entities row: `entities/relay/` with purpose "useRelayEnabled, useRelayMessages, useRelayEndpoints, useRelayMetrics, useRelayEventStream"
   - Add to features row: `features/relay/` with purpose "RelayPanel, ActivityFeed, MessageRow, EndpointList, InboxView"

5. **Environment variables** — Add `DORKOS_RELAY_ENABLED` mention somewhere appropriate, noting it's in `globalPassThroughEnv` in turbo.json.

**Acceptance Criteria:**

- Route groups count updated to ten
- `routes/relay.ts` documented in route groups list
- `services/relay-state.ts` documented in services list
- Services count incremented
- MCP tool server description mentions 4 relay tools
- FSD layers table includes `entities/relay/` and `features/relay/`
- `DORKOS_RELAY_ENABLED` mentioned in env var context
- No existing documentation removed
- Formatting consistent with existing entries

---

### Task 5.2: Register relay schemas in OpenAPI registry

**Subject:** [relay-server-client-integration] [P5] Register relay schemas in OpenAPI registry
**Active Form:** Registering relay endpoints in OpenAPI registry
**Dependencies:** Task 1.3 (relay schemas), Task 1.4 (relay routes), Task 2.2 (SSE endpoint)

Add relay endpoint registrations to `apps/server/src/services/openapi-registry.ts` under a `Relay` tag.

**Add imports:**

```typescript
import {
  SendMessageRequestSchema as RelaySendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
  RelayEnvelopeSchema,
} from '@dorkos/shared/relay-schemas';
```

Note: Import `SendMessageRequestSchema` with alias since there's already a `SendMessageRequestSchema` from `@dorkos/shared/schemas`.

**Register paths (add after the existing Pulse registrations):**

```typescript
// --- Relay ---

registry.registerPath({
  method: 'post',
  path: '/api/relay/messages',
  tags: ['Relay'],
  summary: 'Send a relay message',
  request: { body: { content: { 'application/json': { schema: RelaySendMessageRequestSchema } } } },
  responses: {
    200: {
      description: 'Message sent',
      content: {
        'application/json': {
          schema: z.object({
            messageId: z.string(),
            deliveredTo: z.array(z.string()),
            warnings: z.array(z.string()).optional(),
          }),
        },
      },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Publish failed',
      content: {
        'application/json': { schema: z.object({ error: z.string(), code: z.string() }) },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/messages',
  tags: ['Relay'],
  summary: 'List relay messages',
  request: { query: MessageListQuerySchema },
  responses: {
    200: {
      description: 'Message list',
      content: {
        'application/json': {
          schema: z.object({
            messages: z.array(RelayEnvelopeSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/messages/{id}',
  tags: ['Relay'],
  summary: 'Get a single relay message',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Message found',
      content: { 'application/json': { schema: RelayEnvelopeSchema } },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/endpoints',
  tags: ['Relay'],
  summary: 'List registered endpoints',
  responses: {
    200: {
      description: 'Endpoint list',
      content: {
        'application/json': {
          schema: z.array(
            z.object({
              subject: z.string(),
              description: z.string().optional(),
              messageCount: z.number().optional(),
            })
          ),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/relay/endpoints',
  tags: ['Relay'],
  summary: 'Register a new endpoint',
  request: { body: { content: { 'application/json': { schema: EndpointRegistrationSchema } } } },
  responses: {
    201: {
      description: 'Endpoint registered',
      content: {
        'application/json': {
          schema: z.object({
            subject: z.string(),
            description: z.string().optional(),
            messageCount: z.number(),
          }),
        },
      },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/relay/endpoints/{subject}',
  tags: ['Relay'],
  summary: 'Unregister an endpoint',
  request: { params: z.object({ subject: z.string() }) },
  responses: {
    200: {
      description: 'Endpoint removed',
      content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/endpoints/{subject}/inbox',
  tags: ['Relay'],
  summary: 'Read endpoint inbox',
  request: {
    params: z.object({ subject: z.string() }),
    query: InboxQuerySchema,
  },
  responses: {
    200: {
      description: 'Inbox messages',
      content: {
        'application/json': {
          schema: z.object({
            messages: z.array(RelayEnvelopeSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    404: {
      description: 'Endpoint not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/dead-letters',
  tags: ['Relay'],
  summary: 'List dead letter queue',
  responses: {
    200: {
      description: 'Dead letter entries',
      content: { 'application/json': { schema: z.array(z.unknown()) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/metrics',
  tags: ['Relay'],
  summary: 'Get relay system metrics',
  responses: {
    200: {
      description: 'Relay metrics',
      content: {
        'application/json': {
          schema: z.object({
            totalMessages: z.number(),
            totalEndpoints: z.number(),
            deadLetters: z.number(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/stream',
  tags: ['Relay'],
  summary: 'SSE event stream for real-time relay messages',
  request: {
    query: z.object({
      subject: z.string().optional().describe('NATS-style subject pattern filter'),
    }),
  },
  responses: {
    200: { description: 'SSE event stream' },
  },
});
```

**Acceptance Criteria:**

- All 10 relay endpoints registered in OpenAPI registry
- All registrations use `tags: ['Relay']`
- `SendMessageRequestSchema` imported with alias to avoid naming collision
- Request schemas reference the Zod schemas from `relay-schemas.ts`
- Response schemas match the actual route response shapes
- Relay endpoints visible in Scalar docs at `/api/docs`
- Existing OpenAPI registrations unaffected
- TypeScript compiles without errors

---

### Task 5.3: Update contributing/api-reference.md with relay endpoints

**Subject:** [relay-server-client-integration] [P5] Update api-reference.md with relay endpoints
**Active Form:** Updating API reference documentation for relay
**Dependencies:** Task 1.4 (relay routes), Task 2.2 (SSE stream)

Add a Relay section to `contributing/api-reference.md` documenting all relay endpoints.

**Add section after existing endpoint documentation:**

```markdown
## Relay Endpoints

All relay endpoints require `DORKOS_RELAY_ENABLED=true` (or `relay.enabled: true` in config). When disabled, relay routes are not mounted.

### Messages

| Method | Path                      | Description                         |
| ------ | ------------------------- | ----------------------------------- |
| `POST` | `/api/relay/messages`     | Send a message to a subject         |
| `GET`  | `/api/relay/messages`     | List messages with optional filters |
| `GET`  | `/api/relay/messages/:id` | Get a single message by ID          |

**POST /api/relay/messages** — Request body validated by `SendMessageRequestSchema`:

- `subject` (string, required) — NATS-style subject
- `payload` (any, required) — JSON-serializable message payload
- `from` (string, required) — Sender endpoint subject
- `replyTo` (string, optional) — Reply-to subject
- `budget` (object, optional) — `{ maxHops?, ttl?, callBudgetRemaining? }`

**GET /api/relay/messages** — Query params validated by `MessageListQuerySchema`:

- `subject` (string) — Filter by subject pattern
- `status` (enum: new, cur, failed) — Filter by status
- `from` (string) — Filter by sender
- `cursor` (string) — Pagination cursor
- `limit` (number, 1-100, default 50) — Page size

### Endpoints

| Method   | Path                                  | Description               |
| -------- | ------------------------------------- | ------------------------- |
| `GET`    | `/api/relay/endpoints`                | List registered endpoints |
| `POST`   | `/api/relay/endpoints`                | Register a new endpoint   |
| `DELETE` | `/api/relay/endpoints/:subject`       | Unregister an endpoint    |
| `GET`    | `/api/relay/endpoints/:subject/inbox` | Read endpoint inbox       |

### Other

| Method | Path                      | Description                                    |
| ------ | ------------------------- | ---------------------------------------------- |
| `GET`  | `/api/relay/dead-letters` | List dead letter queue                         |
| `GET`  | `/api/relay/metrics`      | System metrics                                 |
| `GET`  | `/api/relay/stream`       | SSE event stream (supports `?subject=` filter) |

### SSE Stream

`GET /api/relay/stream` establishes a Server-Sent Events connection for real-time relay message monitoring.

Query params:

- `subject` (string, optional) — NATS-style pattern filter (default `>` matches all)

Events:

- `relay_connected` — Sent on initial connection. Data: `{ timestamp }`
- `relay_message` — Sent for each new message. Data: full `RelayEnvelope` object. Includes SSE event ID from envelope ULID.

Keepalive: SSE comment (`: keepalive`) sent every 15 seconds.
```

**Acceptance Criteria:**

- Relay section added to `contributing/api-reference.md`
- All 10 endpoints documented with method, path, description
- Request schemas referenced by name (SendMessageRequestSchema, etc.)
- Query parameters documented for GET endpoints
- SSE stream event types documented
- Feature flag requirement noted
- Formatting consistent with existing documentation style

---

## Dependency Graph

```
Phase 1 (Foundation):
  Task 1.1 (relay-state.ts)       ──┐
  Task 1.2 (config-schema, turbo) ──┤
  Task 1.3 (relay schemas)        ──┤──→ Task 1.4 (relay routes) ──→ Task 1.6 (route tests)
                                    │                                       │
                                    └──→ Task 1.5 (index.ts + config)     │
                                          ↓                                │
Phase 2 (MCP + SSE):                     │                                │
  Task 2.1 (MCP tools) ←─────────────────┘                                │
  Task 2.2 (SSE stream) ←── Task 1.4                                     │
                                                                           │
Phase 3 (Client Entities):                                                │
  Task 3.1 (entity hooks) ←── Task 1.4, Task 2.2                         │
                                                                           │
Phase 4 (Client Features):                                                │
  Task 4.1 (RelayPanel) ←── Task 3.1                                     │
  Task 4.2 (Sidebar integration) ←── Task 4.1, Task 3.1                  │
                                                                           │
Phase 5 (Docs):                                                           │
  Task 5.1 (AGENTS.md) ←── All implementation tasks                      │
  Task 5.2 (OpenAPI) ←── Task 1.3, Task 1.4, Task 2.2                    │
  Task 5.3 (api-reference.md) ←── Task 1.4, Task 2.2                     │
```

## Parallel Execution Opportunities

**Phase 1 parallelism:**

- Tasks 1.1, 1.2, 1.3 can all run in parallel (no dependencies)
- Task 1.4 depends on 1.1 and 1.3
- Task 1.5 depends on 1.1, 1.2, and 1.4
- Task 1.6 depends on 1.4

**Phase 2 parallelism:**

- Tasks 2.1 and 2.2 can run in parallel (both depend on Phase 1 tasks but not each other)

**Phase 3-5:**

- Task 3.1 depends on Phase 1 + 2 completions
- Tasks 4.1, 4.2 are sequential
- Tasks 5.1, 5.2, 5.3 can all run in parallel

**Optimal execution with 2 workers:**

1. Worker A: Task 1.1 → Task 1.4 → Task 2.2 → Task 4.1 → Task 5.1
2. Worker B: Task 1.2 + 1.3 → Task 1.5 → Task 2.1 → Task 1.6 → Task 3.1 → Task 4.2 → Task 5.2 + 5.3
