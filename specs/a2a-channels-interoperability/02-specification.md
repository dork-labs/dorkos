# A2A External Gateway

## Status

Draft

## Authors

- Claude Code — 2026-03-22

## Overview

Add external interoperability to DorkOS by implementing an A2A external gateway that exposes DorkOS agents as A2A-compliant endpoints for cross-vendor agent communication, with Agent Card generation from the Mesh registry for agent discovery. Relay remains the internal backbone — A2A is an external gateway that translates inbound requests to Relay publishes.

## Background / Problem Statement

DorkOS agents currently operate in isolation. No external agent — whether from LangGraph, Google ADK, Spring AI, or another DorkOS instance — can discover or communicate with a DorkOS-managed agent. The A2A protocol (Google/Linux Foundation, 150+ organizations, pre-1.0) is the emerging standard for cross-vendor agent interoperability. Without A2A support, DorkOS agents are invisible to the broader agent ecosystem.

A2A does not replace what DorkOS already does well (broker-mediated pub/sub, persistent mailboxes, namespace isolation, multi-runtime adapters). It fills the external discovery and communication gap that DorkOS doesn't currently address.

> **Note:** Claude Code Channels was originally in scope as a delivery optimization (Relay → Claude Code session context). It was removed after research revealed Channels is currently broken for most scenarios: CLI-only (no SDK support), broken when idle (duplicate-spawn bug #36800 orphans notification listeners), and in research preview with no stable timeline. See `research/20260322_channels_idle_sdk_lifecycle_behavior.md`. Channels can be revisited when Anthropic stabilizes the feature.

## Goals

- Enable external A2A clients to discover DorkOS agents via standard `/.well-known/agent.json` endpoint
- Enable external A2A clients to invoke DorkOS agents via JSON-RPC 2.0 (`message/send`, `message/stream`)
- Generate Agent Cards dynamically from the existing Mesh agent registry
- Persist A2A task state in SQLite for restart survival and history queries
- Maintain Relay as the sole internal transport — A2A requests translate to Relay publishes
- Follow existing DorkOS patterns (hexagonal architecture, feature flags, auth middleware)

## Non-Goals

- Replacing Relay with A2A for internal agent communication (A2A scales O(n²), Relay scales O(n))
- gRPC or HTTP/REST A2A bindings (JSON-RPC only for initial release)
- Agent Teams integration (orthogonal Claude Code feature)
- Claude Code Channels delivery optimization (removed from scope — Channels is broken in research preview, see Background note)
- A2A Client for outbound delegation to external agents (deferred to post-A2A-1.0)
- OAuth2/OIDC/mTLS authentication (API key auth only)
- A2A cross-instance discovery (external consumer's responsibility)
- Client-side UI for A2A management
- Migrating to A2A v1.0 (Protocol v1.0 has shipped but SDK is still at v0.3.x; upgrade planned when SDK ships v1.0 support)

## Technical Dependencies

| Dependency       | Version                              | Purpose                                                                   |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `@a2a-js/sdk`    | `0.3.13` (exact pin)                 | A2A protocol SDK — Express handlers, task store, agent executor interface |
| `express`        | `^4.21.0` (already in monorepo)      | HTTP server for A2A routes                                                |
| `drizzle-orm`    | `^0.39.0` (already in monorepo)      | SQLite ORM for A2A task state table                                       |
| `better-sqlite3` | Already in monorepo via `@dorkos/db` | SQLite driver                                                             |

**External protocol references:**

- [A2A Protocol Specification v0.3.0](https://a2a-protocol.org/v0.3.0/specification/)

## Detailed Design

### Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │          External Agent Ecosystem          │
                    │  (LangGraph, Google ADK, Spring AI, ...)  │
                    └──────────────────┬───────────────────────┘
                                       │
                              A2A Protocol (JSON-RPC/SSE)
                                       │
┌──────────────────────────────────────▼──────────────────────────────────┐
│                         DorkOS Server (Express)                         │
│                                                                         │
│  GET /.well-known/agent.json ──► Fleet Agent Card (Mesh registry)      │
│  GET /a2a/agents/:id/card ────► Per-Agent Card (AgentManifest → Card)  │
│  POST /a2a ───────────────────► JSON-RPC Handler (SDK DefaultHandler)  │
│                                       │                                 │
│                              ┌────────▼────────┐                       │
│                              │ packages/        │                       │
│                              │ a2a-gateway/     │                       │
│                              │  ├ executor.ts   │                       │
│                              │  ├ translator.ts │                       │
│                              │  ├ card-gen.ts   │                       │
│                              │  └ task-store.ts │                       │
│                              └────────┬────────┘                       │
│                                       │                                 │
│                              Translate: A2A ↔ Relay                    │
│                                       │                                 │
├───────────────────────────────────────▼─────────────────────────────────┤
│                         DorkOS Relay (Internal Bus)                      │
│  NATS-style subjects: relay.agent.{ns}.{id}, relay.human.{platform}    │
│  Maildir persistence, circuit breakers, backpressure, DLQ              │
├─────────┬──────────┬──────────┬──────────┬──────────────────────────────┤
│         │          │          │          │                               │
▼         ▼          ▼          ▼          ▼                               │
Claude   Slack     Telegram  Webhook    Future                            │
Code     Adapter   Adapter   Adapter   Adapters                           │
Adapter                                                                   │
                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Package Structure

#### New Package 1: `packages/a2a-gateway/`

A2A protocol handler, schema translation, Agent Card generation, and task state management. Separate package for clean boundaries and independent testability.

```
packages/a2a-gateway/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Package barrel export
│   ├── agent-card-generator.ts     # AgentManifest → A2A AgentCard mapping
│   ├── schema-translator.ts        # A2A Message/Task ↔ Relay Envelope/StandardPayload
│   ├── task-store.ts               # SQLite-backed A2A task state (implements TaskStore)
│   ├── dorkos-executor.ts          # AgentExecutor implementation bridging to Relay
│   ├── types.ts                    # A2A-specific TypeScript types
│   └── __tests__/
│       ├── agent-card-generator.test.ts
│       ├── schema-translator.test.ts
│       ├── task-store.test.ts
│       └── dorkos-executor.test.ts
```

**`package.json`:**

```json
{
  "name": "@dorkos/a2a-gateway",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@a2a-js/sdk": "0.2.5",
    "@dorkos/db": "workspace:*",
    "@dorkos/shared": "workspace:*"
  },
  "devDependencies": {
    "@dorkos/typescript-config": "workspace:*",
    "vitest": "^3.1.0"
  }
}
```

### Component Design

#### 1. Agent Card Generator (`agent-card-generator.ts`)

Maps `AgentManifest` (from Mesh registry) to A2A `AgentCard` (v0.3.0 format).

```typescript
import type { AgentCard, AgentSkill } from '@a2a-js/sdk';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Configuration for Agent Card generation. */
export interface CardGeneratorConfig {
  /** Base URL where the DorkOS server is accessible (e.g., "https://dorkos.example.com"). */
  baseUrl: string;
  /** DorkOS version string for the Agent Card version field. */
  version: string;
}

/**
 * Generate a per-agent A2A Agent Card from a Mesh AgentManifest.
 *
 * Maps AgentManifest fields to A2A AgentCard fields:
 * - manifest.name → card.name
 * - manifest.description → card.description
 * - manifest.capabilities → card.skills (each capability becomes a skill)
 * - manifest.id → card.url (as /a2a/agents/:id endpoint)
 */
export function generateAgentCard(manifest: AgentManifest, config: CardGeneratorConfig): AgentCard {
  const skills: AgentSkill[] = manifest.capabilities.map((cap) => ({
    id: cap,
    name: cap.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `${manifest.name} capability: ${cap}`,
    tags: [cap, manifest.runtime],
    examples: [],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  }));

  return {
    protocolVersion: '0.3.0',
    name: manifest.name,
    description: manifest.description || `DorkOS agent: ${manifest.name}`,
    url: `${config.baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: config.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
      },
    },
    security: [{ apiKey: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}

/**
 * Generate a fleet-level Agent Card listing all registered agents.
 *
 * The fleet card acts as a directory — external clients discover
 * all agents in one request, then fetch individual cards for details.
 */
export function generateFleetCard(
  manifests: AgentManifest[],
  config: CardGeneratorConfig
): AgentCard {
  const skills: AgentSkill[] = manifests.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description || `Agent: ${m.name}`,
    tags: [m.runtime, ...(m.namespace ? [m.namespace] : [])],
    examples: [],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  }));

  return {
    protocolVersion: '0.3.0',
    name: 'DorkOS Agent Fleet',
    description: `DorkOS instance with ${manifests.length} registered agent(s). Use per-agent cards at /a2a/agents/:id/card for individual agent details.`,
    url: `${config.baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: config.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
      },
    },
    security: [{ apiKey: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}
```

#### 2. Schema Translator (`schema-translator.ts`)

Bidirectional translation between A2A Messages/Tasks and Relay Envelopes/StandardPayload.

```typescript
import type { Message, Part, Task, TaskState } from '@a2a-js/sdk';
import type { RelayEnvelope, StandardPayload } from '@dorkos/shared/relay-schemas';

/**
 * Translate an inbound A2A Message to a Relay StandardPayload.
 *
 * Mapping:
 * - A2A message.parts[0].text → StandardPayload.content
 * - A2A message.contextId → StandardPayload.conversationId
 * - A2A message.taskId → StandardPayload.correlationId
 * - A2A role → StandardPayload.channelType = 'dm'
 */
export function a2aMessageToRelayPayload(message: Message): StandardPayload {
  const textParts = message.parts
    .filter((p: Part) => p.kind === 'text')
    .map((p: Part) => (p as { kind: 'text'; text: string }).text);

  return {
    content: textParts.join('\n'),
    senderName: 'a2a-client',
    channelType: 'dm',
    conversationId: message.contextId,
    correlationId: message.taskId,
    responseContext: {
      platform: 'a2a',
      supportedFormats: ['text/plain'],
    },
    performative: 'request',
  };
}

/**
 * Translate a Relay envelope's StandardPayload into an A2A Message.
 *
 * Used when converting Relay responses back to A2A format for SSE streaming.
 */
export function relayPayloadToA2aMessage(
  payload: StandardPayload,
  taskId: string,
  contextId: string
): Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: payload.content }],
    taskId,
    contextId,
  };
}

/**
 * Map a Relay delivery status to an A2A TaskState.
 */
export function relayStatusToTaskState(
  status: 'sent' | 'delivered' | 'failed' | 'timeout'
): TaskState {
  switch (status) {
    case 'sent':
      return 'working';
    case 'delivered':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'failed';
  }
}
```

#### 3. SQLite Task Store (`task-store.ts`)

Implements the `@a2a-js/sdk` `TaskStore` interface backed by SQLite via Drizzle ORM. Survives server restarts and enables task history queries.

**Database table (`packages/db/src/schema/a2a.ts`):**

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** A2A task state persistence. */
export const a2aTasks = sqliteTable('a2a_tasks', {
  id: text('id').primaryKey(),
  contextId: text('context_id').notNull(),
  agentId: text('agent_id').notNull(),
  status: text('status', {
    enum: ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'rejected'],
  })
    .notNull()
    .default('submitted'),
  historyJson: text('history_json').notNull().default('[]'),
  artifactsJson: text('artifacts_json').notNull().default('[]'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

**Task store implementation:**

```typescript
import type { Task, TaskStore, TaskQueryParams } from '@a2a-js/sdk';
import { eq } from 'drizzle-orm';
import type { Db } from '@dorkos/db';
import { a2aTasks } from '@dorkos/db/schema';

/** SQLite-backed TaskStore for A2A task persistence. */
export class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: Db) {}

  async get(params: TaskQueryParams): Promise<Task | null> {
    const row = this.db.select().from(a2aTasks).where(eq(a2aTasks.id, params.id)).get();

    return row ? this.rowToTask(row) : null;
  }

  async save(task: Task): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .insert(a2aTasks)
      .values({
        id: task.id,
        contextId: task.contextId,
        agentId: this.extractAgentId(task),
        status: task.status.state,
        historyJson: JSON.stringify(task.history ?? []),
        artifactsJson: JSON.stringify(task.artifacts ?? []),
        metadataJson: task.metadata ? JSON.stringify(task.metadata) : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: a2aTasks.id,
        set: {
          status: task.status.state,
          historyJson: JSON.stringify(task.history ?? []),
          artifactsJson: JSON.stringify(task.artifacts ?? []),
          metadataJson: task.metadata ? JSON.stringify(task.metadata) : null,
          updatedAt: now,
        },
      })
      .run();
  }

  private rowToTask(row: typeof a2aTasks.$inferSelect): Task {
    return {
      kind: 'task',
      id: row.id,
      contextId: row.contextId,
      status: {
        state: row.status as Task['status']['state'],
        timestamp: row.updatedAt,
      },
      history: JSON.parse(row.historyJson),
      artifacts: JSON.parse(row.artifactsJson),
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) : undefined,
    };
  }

  private extractAgentId(task: Task): string {
    return (task.metadata as Record<string, string>)?.agentId ?? 'unknown';
  }
}
```

#### 4. DorkOS Agent Executor (`dorkos-executor.ts`)

Implements the `@a2a-js/sdk` `AgentExecutor` interface, bridging A2A requests to Relay publishes and subscribing to responses.

```typescript
import type {
  AgentExecutor,
  RequestContext,
  IExecutionEventBus,
  TaskStatusUpdateEvent,
  TaskState,
} from '@a2a-js/sdk';
import type { RelayCore } from '@dorkos/relay';
import type { AgentRegistry } from '@dorkos/mesh';
import { a2aMessageToRelayPayload, relayPayloadToA2aMessage } from './schema-translator.js';

/** Configuration for the DorkOS A2A executor. */
export interface ExecutorDeps {
  relay: RelayCore;
  agentRegistry: AgentRegistry;
}

/**
 * AgentExecutor that bridges A2A requests to the DorkOS Relay bus.
 *
 * Flow:
 * 1. Receive A2A request via execute()
 * 2. Resolve target agent from Mesh registry
 * 3. Translate A2A Message → Relay StandardPayload
 * 4. Publish to Relay via relayCore.publish()
 * 5. Subscribe to response subject for reply
 * 6. Translate Relay response → A2A TaskStatusUpdate
 * 7. Publish completion event via eventBus
 */
export class DorkOSAgentExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();

  constructor(private readonly deps: ExecutorDeps) {}

  async execute(requestContext: RequestContext, eventBus: IExecutionEventBus): Promise<void> {
    const { userMessage, task: existingTask } = requestContext;
    const taskId = existingTask?.id ?? requestContext.taskId;
    const contextId = userMessage.contextId ?? existingTask?.contextId ?? taskId;

    // Resolve target agent from metadata or default
    const agentId = (userMessage.metadata as Record<string, string>)?.agentId;
    const agent = agentId
      ? this.deps.agentRegistry.get(agentId)
      : this.deps.agentRegistry.list()[0];

    if (!agent) {
      this.publishFailure(eventBus, taskId, contextId, 'No matching agent found');
      return;
    }

    // Publish "working" status
    this.publishStatus(eventBus, taskId, contextId, 'working', 'Processing request...');

    // Translate A2A message to Relay payload
    const payload = a2aMessageToRelayPayload(userMessage);
    const subject = `relay.agent.${agent.namespace ?? 'default'}.${agent.id}`;

    try {
      // Publish to Relay
      const result = await this.deps.relay.publish(subject, payload, {
        from: 'a2a-gateway',
        replyTo: `relay.a2a.response.${taskId}`,
      });

      if (result.status === 'failed') {
        this.publishFailure(eventBus, taskId, contextId, 'Relay delivery failed');
        return;
      }

      // Subscribe for response (with timeout)
      const responsePromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          this.publishFailure(eventBus, taskId, contextId, 'Response timeout');
          resolve();
        }, 120_000); // 2 minute timeout

        const unsubscribe = this.deps.relay.subscribe(
          `relay.a2a.response.${taskId}`,
          (envelope) => {
            clearTimeout(timeout);
            unsubscribe();

            if (this.cancelledTasks.has(taskId)) {
              this.publishStatus(eventBus, taskId, contextId, 'canceled');
              resolve();
              return;
            }

            const responsePayload = envelope.payload as { content: string };
            const responseMessage = relayPayloadToA2aMessage(responsePayload, taskId, contextId);

            const completedUpdate: TaskStatusUpdateEvent = {
              kind: 'status-update',
              taskId,
              contextId,
              status: {
                state: 'completed' as TaskState,
                message: responseMessage,
                timestamp: new Date().toISOString(),
              },
              final: true,
            };
            eventBus.publish(completedUpdate);
            resolve();
          }
        );
      });

      await responsePromise;
    } catch (err) {
      this.publishFailure(
        eventBus,
        taskId,
        contextId,
        err instanceof Error ? err.message : 'Unknown error'
      );
    }
  }

  async cancelTask(taskId: string, eventBus: IExecutionEventBus): Promise<void> {
    this.cancelledTasks.add(taskId);
  }

  private publishStatus(
    eventBus: IExecutionEventBus,
    taskId: string,
    contextId: string,
    state: string,
    messageText?: string
  ): void {
    const update: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: state as TaskState,
        timestamp: new Date().toISOString(),
        ...(messageText && {
          message: {
            kind: 'message',
            role: 'agent',
            messageId: crypto.randomUUID(),
            parts: [{ kind: 'text', text: messageText }],
            taskId,
            contextId,
          },
        }),
      },
      final: state === 'completed' || state === 'failed' || state === 'canceled',
    };
    eventBus.publish(update);
  }

  private publishFailure(
    eventBus: IExecutionEventBus,
    taskId: string,
    contextId: string,
    reason: string
  ): void {
    this.publishStatus(eventBus, taskId, contextId, 'failed', `Error: ${reason}`);
  }
}
```

#### 5. Server Route Handler (`apps/server/src/routes/a2a.ts`)

Express routes mounting A2A gateway endpoints, following the MCP route pattern.

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { A2AExpressApp, DefaultRequestHandler, type AgentCard } from '@a2a-js/sdk';
import type { AgentRegistry } from '@dorkos/mesh';
import type { RelayCore } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import {
  generateFleetCard,
  generateAgentCard,
  SqliteTaskStore,
  DorkOSAgentExecutor,
  type CardGeneratorConfig,
} from '@dorkos/a2a-gateway';

/** Dependencies injected into the A2A route factory. */
export interface A2aRouteDeps {
  agentRegistry: AgentRegistry;
  relay: RelayCore;
  db: Db;
  baseUrl: string;
  version: string;
}

/**
 * Create the A2A Express router.
 *
 * Mounts three endpoints:
 * - GET /.well-known/agent.json — Fleet Agent Card (all agents)
 * - GET /a2a/agents/:id/card — Per-agent Agent Card
 * - POST /a2a — JSON-RPC 2.0 handler (message/send, message/stream, tasks/get, tasks/cancel)
 */
export function createA2aRouter(deps: A2aRouteDeps): Router {
  const router = Router();
  const config: CardGeneratorConfig = {
    baseUrl: deps.baseUrl,
    version: deps.version,
  };

  // Fleet Agent Card (well-known discovery endpoint)
  router.get('/.well-known/agent.json', (_req: Request, res: Response) => {
    const manifests = deps.agentRegistry.list();
    const fleetCard = generateFleetCard(manifests, config);
    res.json(fleetCard);
  });

  // Per-agent Agent Card
  router.get('/a2a/agents/:id/card', (req: Request, res: Response) => {
    const agent = deps.agentRegistry.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const card = generateAgentCard(agent, config);
    res.json(card);
  });

  // JSON-RPC 2.0 handler — mount SDK's A2AExpressApp
  const taskStore = new SqliteTaskStore(deps.db);
  const executor = new DorkOSAgentExecutor({
    relay: deps.relay,
    agentRegistry: deps.agentRegistry,
  });

  const fleetCard = (): AgentCard => {
    const manifests = deps.agentRegistry.list();
    return generateFleetCard(manifests, config);
  };

  const requestHandler = new DefaultRequestHandler(fleetCard(), taskStore, executor);

  const a2aApp = new A2AExpressApp(requestHandler);
  const a2aRouter = a2aApp.setupRoutes(Router(), '/a2a');
  router.use(a2aRouter);

  return router;
}
```

**Route registration in `apps/server/src/index.ts`:**

```typescript
// Conditional A2A route mounting (after Relay initialization)
if (env.DORKOS_A2A_ENABLED && relayCore) {
  const { createA2aRouter } = await import('./routes/a2a.js');
  app.use(
    mcpApiKeyAuth, // Reuse MCP auth middleware
    createA2aRouter({
      agentRegistry: meshCore.agentRegistry,
      relay: relayCore,
      db,
      baseUrl: `http://${env.DORKOS_HOST}:${env.DORKOS_PORT}`,
      version: env.DORKOS_VERSION_OVERRIDE ?? '0.0.0',
    })
  );
  logger.info('A2A gateway mounted at /.well-known/agent.json and /a2a');
}
```

#### 6. Feature Flag (`apps/server/src/env.ts`)

```typescript
// Add to serverEnvSchema:
DORKOS_A2A_ENABLED: boolFlag,  // Default: 'false' (same boolFlag transform as RELAY/PULSE)
```

**Turbo passthrough (`turbo.json`):**

```json
{
  "globalPassThroughEnv": [
    "DORKOS_A2A_ENABLED"
    // ... existing vars
  ]
}
```

### API Changes

#### New Endpoints

| Method | Path                      | Auth               | Description                                           |
| ------ | ------------------------- | ------------------ | ----------------------------------------------------- |
| `GET`  | `/.well-known/agent.json` | API Key (optional) | Fleet Agent Card — directory of all registered agents |
| `GET`  | `/a2a/agents/:id/card`    | API Key (optional) | Per-agent Agent Card with skills from capabilities    |
| `POST` | `/a2a`                    | API Key (optional) | A2A JSON-RPC 2.0 handler                              |

#### JSON-RPC 2.0 Methods (via `POST /a2a`)

| Method           | Parameters                                   | Returns                               | Description                                |
| ---------------- | -------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| `message/send`   | `MessageSendParams` (message, configuration) | `Task`                                | Send message to agent, wait for completion |
| `message/stream` | `MessageSendParams`                          | SSE stream of `TaskStatusUpdateEvent` | Send message, receive streaming response   |
| `tasks/get`      | `TaskQueryParams` (id)                       | `Task`                                | Query task state by ID                     |
| `tasks/cancel`   | `TaskIdParams` (id)                          | `Task`                                | Cancel an in-progress task                 |

### Data Model Changes

New SQLite table `a2a_tasks` in `packages/db/src/schema/a2a.ts` (see task store section above). Added to the consolidated schema export in `packages/db/src/schema/index.ts`.

## User Experience

### External A2A Client Perspective

1. **Discovery:** Client fetches `GET https://dorkos.example.com/.well-known/agent.json` and receives a fleet-level Agent Card listing all available agents as skills
2. **Agent Selection:** Client fetches `GET https://dorkos.example.com/a2a/agents/{id}/card` for detailed capabilities of a specific agent
3. **Invocation:** Client sends `POST https://dorkos.example.com/a2a` with JSON-RPC `message/send` or `message/stream`
4. **Streaming:** For `message/stream`, client receives SSE events with `TaskStatusUpdateEvent` containing status transitions and response messages
5. **Status Check:** Client can query `tasks/get` at any time for current task state

### DorkOS Operator Perspective

1. **Enable:** Set `DORKOS_A2A_ENABLED=true` in `.env` (requires `DORKOS_RELAY_ENABLED=true`)
2. **Secure:** Optionally set `MCP_API_KEY` for Bearer token authentication
3. **Verify:** Check `GET /.well-known/agent.json` returns registered agents
4. **Monitor:** A2A task history queryable via SQLite (future: admin UI)

## Testing Strategy

### Unit Tests

**`packages/a2a-gateway/src/__tests__/agent-card-generator.test.ts`:**

- Verify `generateAgentCard()` produces valid A2A Agent Card from a minimal `AgentManifest`
- Verify capabilities → skills mapping (each capability becomes a skill with proper id, name, tags)
- Verify `generateFleetCard()` aggregates multiple agents as skills
- Test edge cases: agent with empty capabilities, empty description, no namespace

**`packages/a2a-gateway/src/__tests__/schema-translator.test.ts`:**

- Verify `a2aMessageToRelayPayload()` maps text parts to `StandardPayload.content`
- Verify `relayPayloadToA2aMessage()` creates proper A2A Message with text parts
- Verify `relayStatusToTaskState()` maps all Relay statuses correctly
- Test multi-part messages (concatenated text)
- Test messages with metadata preservation

**`packages/a2a-gateway/src/__tests__/task-store.test.ts`:**

- Verify `save()` persists task to SQLite
- Verify `get()` retrieves task by ID
- Verify upsert behavior (save twice, get returns latest)
- Test null/missing task returns null
- Test JSON serialization/deserialization of history and artifacts

**`packages/a2a-gateway/src/__tests__/dorkos-executor.test.ts`:**

- Verify execute() publishes to correct Relay subject
- Verify working → completed state transition on Relay response
- Verify working → failed state transition on Relay error
- Verify cancelTask() marks task as canceled
- Verify 2-minute timeout produces failure
- Test agent not found scenario
- Mock `RelayCore` and `AgentRegistry` using vi.fn()

### Integration Tests

**`apps/server/src/__tests__/a2a-routes.test.ts`:**

- Test `GET /.well-known/agent.json` returns valid Agent Card with registered agents
- Test `GET /a2a/agents/:id/card` returns agent-specific card
- Test `GET /a2a/agents/:id/card` returns 404 for unknown agent
- Test `POST /a2a` with `message/send` returns Task with completed status
- Test API key authentication (401 when key is set but not provided)
- Test A2A routes not mounted when `DORKOS_A2A_ENABLED=false`
- Use mock `AgentRegistry` pre-loaded with test agents
- Use mock `RelayCore` that captures publish calls and triggers response subscriptions

### Mocking Strategies

| Dependency      | Mock Approach                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `RelayCore`     | `vi.fn()` spies on `publish()` and `subscribe()`. Subscribe mock triggers callback with test envelope. |
| `AgentRegistry` | In-memory registry pre-loaded with test `AgentManifest` entries                                        |
| `Db` (SQLite)   | In-memory SQLite via `better-sqlite3` (Drizzle supports this natively)                                 |

## Performance Considerations

- **Agent Card generation:** Cards are generated dynamically from Mesh registry on each request. For fleets with many agents, consider caching with TTL if latency becomes an issue.
- **SQLite task store:** Uses the same WAL-mode SQLite as the rest of DorkOS. Task table growth is bounded — implement periodic cleanup of terminal tasks (completed/failed/canceled older than 24 hours).
- **SSE streaming:** Each `message/stream` request holds an open HTTP connection. Impose a maximum concurrent A2A streams limit (default: 50) to prevent resource exhaustion.
- **Relay publish overhead:** A2A requests add one Relay publish per inbound message. Relay's existing backpressure and circuit breaker mechanisms apply.

## Security Considerations

- **Authentication:** Reuses `MCP_API_KEY` Bearer token scheme. When `MCP_API_KEY` is set, all A2A endpoints require authentication. When unset, endpoints are open (local development mode).
- **Agent Card exposure:** Agent Cards expose agent names, descriptions, and capabilities to external clients. This is intentional for discovery but operators should be aware that `/.well-known/agent.json` makes the agent fleet visible.
- **Input validation:** All inbound A2A JSON-RPC requests are validated by the SDK's `DefaultRequestHandler`. The schema translator performs additional validation before creating Relay envelopes.
- **Relay isolation:** A2A requests are published with `from: 'a2a-gateway'` — existing Relay access control and budget enforcement apply. A2A cannot bypass namespace isolation.
- **No secrets in Agent Cards:** Agent Cards never expose API keys, internal paths, or configuration. Only public metadata (name, description, capabilities, endpoint URL).

## Documentation

### New Documentation

- `docs/a2a-gateway.mdx` — External A2A gateway setup, configuration, and usage guide
- `contributing/a2a-gateway.md` — Internal developer guide for the A2A gateway package

### Updated Documentation

- `contributing/architecture.md` — Add A2A gateway to architecture diagram
- `contributing/api-reference.md` — Add A2A endpoints to OpenAPI spec
- `contributing/environment-variables.md` — Add `DORKOS_A2A_ENABLED`
- `docs/configuration.mdx` — Document new environment variables

## Implementation Phases

### Phase 1: Foundation — Agent Card Generation + Package Scaffolding

- Create `packages/a2a-gateway/` package with `package.json`, `tsconfig.json`, build config
- Implement `agent-card-generator.ts` (AgentManifest → AgentCard mapping)
- Implement `types.ts` with A2A-specific TypeScript types
- Add A2A task table to `packages/db/src/schema/a2a.ts`
- Add `DORKOS_A2A_ENABLED` feature flag to `apps/server/src/env.ts`
- Create `apps/server/src/routes/a2a.ts` with Agent Card endpoints only
- Mount routes in `apps/server/src/index.ts` (conditional on feature flag)
- Tests for Agent Card generation and route handler

### Phase 2: A2A Gateway — JSON-RPC Handler + Schema Translation

- Install `@a2a-js/sdk` (pin exact version)
- Implement `schema-translator.ts` (A2A ↔ Relay bidirectional translation)
- Implement `task-store.ts` (SQLite-backed TaskStore)
- Implement `dorkos-executor.ts` (AgentExecutor bridging to Relay)
- Wire SDK's `DefaultRequestHandler` and `A2AExpressApp` into route handler
- Add `POST /a2a` JSON-RPC endpoint with full `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`
- Integration tests for end-to-end A2A → Relay → response flow

### Phase 3: Polish — Documentation, Turbo Config, Cleanup

- Update `turbo.json` with new package build targets and env vars
- Write external docs (`docs/a2a-gateway.mdx`)
- Write internal developer guide (`contributing/a2a-gateway.md`)
- Update architecture diagram in `contributing/architecture.md`
- Register A2A endpoints with OpenAPI schema
- Add periodic cleanup for terminal A2A tasks
- End-to-end smoke test with a real A2A client (optional)

## Open Questions

1. ~~**SDK Version Availability**~~ (RESOLVED)
   **Answer:** `@a2a-js/sdk` v0.3.13 is available on npm (released 2026-03-16). Pin to exact version `0.3.13`.
   **Rationale:** Confirmed available at https://www.npmjs.com/package/@a2a-js/sdk. The 403 during initial research was transient.

2. ~~**A2A v1.0 Migration Path**~~ (RESOLVED)
   **Answer:** Build against Protocol v0.3 using SDK v0.3.13. Design the translation layer to be version-aware for future v1.0 migration. Create a follow-up spec when the SDK ships v1.0 support.
   **Rationale:** A2A Protocol v1.0.0 has shipped (https://a2a-protocol.org/latest/specification/), but the official JS SDK remains at v0.3.x with no v1.0 entries in its changelog. v1.0 provides backward compatibility — "agents can advertise support for both v0.3 and v1.0 simultaneously." Breaking changes are mostly renames/restructures (method names, enum casing, Part unification), not conceptual model changes. The translation layer abstracts these behind our own interfaces, so the upgrade path is: update the translation layer + SDK version, no changes to Relay integration.

3. ~~**Channel Plugin Distribution**~~ (REMOVED)
   **Answer:** Channel plugin removed from scope entirely. Channels is currently broken in research preview (CLI-only, no SDK support, broken when idle due to duplicate-spawn bug #36800, tools not surfaced via bug #37072). See `research/20260322_channels_idle_sdk_lifecycle_behavior.md`.

4. ~~**Relay SSE Stream Endpoint**~~ (REMOVED)
   **Answer:** No longer needed — this endpoint was for the Channel plugin's SSE subscription.

5. ~~**A2A Agent Targeting**~~ (RESOLVED)
   **Answer:** Use `metadata.agentId` in the A2A message to specify the target DorkOS agent, falling back to the first registered agent.
   **Rationale:** This is the most explicit and A2A-idiomatic approach. The `metadata` field in A2A messages is designed for implementation-specific extensions. External clients learn agent IDs from the fleet Agent Card at `/.well-known/agent.json` which lists all agents with their IDs.

## Related ADRs

| ADR      | Title                                   | Relevance                                                                     |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| ADR-0171 | Enable Relay and Pulse by Default       | A2A depends on Relay being enabled; follows same feature flag pattern         |
| ADR-0103 | Optional API Key Auth for MCP           | A2A reuses the same auth middleware and `MCP_API_KEY` env var                 |
| ADR-0102 | Stateless MCP Transport Mode            | A2A route handler follows the same factory-based stateless pattern            |
| ADR-0101 | Embed MCP Server in Express Process     | A2A gateway is embedded in Express, same as MCP                               |
| ADR-0043 | File Canonical Source of Truth for Mesh | Agent Card data comes from Mesh registry, which uses file-first write-through |
| ADR-0010 | Use Maildir for Relay Storage           | Relay persistence layer that A2A task responses flow through                  |

## References

- [A2A Protocol Specification v0.3.0](https://a2a-protocol.org/v0.3.0/specification/)
- [A2A v1.0 Breaking Changes](https://a2a-protocol.org/latest/whats-new-v1/)
- [A2A JS SDK GitHub](https://github.com/a2aproject/a2a-js)
- [HiveMQ: A2A at Enterprise Scale](https://www.hivemq.com/blog/a2a-enterprise-scale-agentic-ai-collaboration-part-1/) — recommends A2A for semantics + message broker for delivery (exactly our architecture)
- Ideation: `specs/a2a-channels-interoperability/01-ideation.md`
- Brief: `specs/a2a-channels-interoperability/00-brief.md`
- Research: `research/20260321_claude_code_channels_a2a_protocol_comparison.md`
- Contributing (adapters): `contributing/relay-adapters.md`
- Contributing (architecture): `contributing/architecture.md`
- Contributing (API): `contributing/api-reference.md`
- MCP route pattern: `apps/server/src/routes/mcp.ts`
