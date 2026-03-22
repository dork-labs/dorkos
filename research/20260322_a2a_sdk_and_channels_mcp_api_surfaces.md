---
title: 'A2A JS SDK and Claude Code Channels MCP: Exact API Surfaces for DorkOS Integration'
date: 2026-03-22
type: external-best-practices
status: active
tags: [a2a, a2a-js-sdk, channels, mcp, notifications, express, agent-card, relay, integration]
searches_performed: 18
sources_count: 22
---

# A2A JS SDK and Claude Code Channels MCP: Exact API Surfaces

## Research Summary

This report documents the precise TypeScript API surfaces for two external dependencies
needed by DorkOS integration specs: (1) `@a2a-js/sdk` v0.3.13, the official A2A Protocol
JavaScript SDK implementing spec v0.3.0, and (2) Claude Code Channels MCP protocol
(`notifications/claude/channel`), a research-preview feature in Claude Code v2.1.80+.
Both are pre-production/preview quality with active breaking changes in flight. The A2A
SDK is on v0.3.0 of the spec while v1.0 is available and involves significant breaking
changes. Channel MCP has two open blocking bugs (#36800 duplicate spawn, #37072 tools
not surfaced) that prevent reliable production use today.

---

## Part 1: @a2a-js/sdk

### Package Details

| Field              | Value                                |
| ------------------ | ------------------------------------ |
| **npm package**    | `@a2a-js/sdk`                        |
| **Latest version** | `0.3.13` (published 2026-03-16)      |
| **Spec version**   | A2A Protocol v0.3.0                  |
| **License**        | Apache 2.0                           |
| **Repository**     | https://github.com/a2aproject/a2a-js |

```bash
npm install @a2a-js/sdk
# For Express integration (peer dep):
npm install express
# For gRPC support:
npm install @grpc/grpc-js @bufbuild/protobuf
```

### Transport Support Matrix

| Transport           | Client | Server |
| ------------------- | :----: | :----: |
| JSON-RPC            |  YES   |  YES   |
| HTTP+JSON/REST      |  YES   |  YES   |
| gRPC (Node.js only) |  YES   |  YES   |

---

### 1.1 Core Type Definitions (v0.3.0)

#### AgentCard

The `AgentCard` is the discovery document served at `/.well-known/agent.json`.

```typescript
interface AgentCard {
  // Required fields
  name: string; // Human-readable agent name
  description: string; // Agent purpose overview
  url: string; // Preferred endpoint URL
  version: string; // Agent version string (e.g., "1.0.0")
  protocolVersion: string; // Always "0.3.0" for this SDK
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  defaultInputModes: string[]; // MIME types, e.g., ["text/plain"]
  defaultOutputModes: string[]; // MIME types, e.g., ["text/plain"]

  // Optional fields
  provider?: {
    organization: string;
    url?: string;
  };
  iconUrl?: string;
  documentationUrl?: string;
  preferredTransport?: string; // Default: "JSONRPC"
  additionalInterfaces?: AgentInterface[];
  securitySchemes?: Record<string, SecurityScheme>;
  security?: SecurityRequirement[];
  supportsAuthenticatedExtendedCard?: boolean;
  signatures?: AgentCardSignature[];
}

interface AgentCapabilities {
  streaming: boolean; // SSE support
  pushNotifications: boolean; // WebHook push support
  stateTransitionHistory?: boolean; // Task history support
}

interface AgentSkill {
  id: string; // Unique skill identifier
  name: string; // Human-readable skill name
  description: string; // What the skill does
  tags: string[]; // For routing/search
  examples?: string[]; // Example inputs
  inputModes?: string[]; // MIME types accepted (overrides defaultInputModes)
  outputModes?: string[]; // MIME types produced (overrides defaultOutputModes)
}

interface AgentInterface {
  url: string;
  transport: string; // e.g., "JSONRPC", "REST", "GRPC"
}
```

**Complete AgentCard example:**

```typescript
const myAgentCard: AgentCard = {
  name: 'My DorkOS Agent',
  description: 'DorkOS-managed Claude Code agent',
  url: 'http://localhost:3000/',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  provider: {
    organization: 'DorkOS',
    url: 'https://example.com',
  },
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    {
      id: 'code_assistant',
      name: 'Code Assistant',
      description: 'Helps with coding tasks',
      tags: ['code', 'programming'],
      examples: ['Write a function that...', 'Debug this error...'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    },
  ],
  securitySchemes: {
    apiKey: {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    },
  },
  security: [{ apiKey: [] }],
  supportsAuthenticatedExtendedCard: false,
};
```

---

#### Task States (v0.3.0)

The `TaskState` enum uses lowercase string values in v0.3.0 (NOTE: v1.0 changes these to `TASK_STATE_SUBMITTED` etc.):

```typescript
import { TaskState } from '@a2a-js/sdk';

// v0.3.0 values — used by @a2a-js/sdk v0.3.13
type TaskState =
  | 'submitted' // Task created, awaiting processing
  | 'working' // Actively processing
  | 'input-required' // Paused, needs user input
  | 'auth-required' // Paused, needs authorization
  | 'completed' // Terminal: success
  | 'failed' // Terminal: error
  | 'canceled' // Terminal: canceled by client
  | 'rejected'; // Terminal: refused by agent
```

Terminal states: `completed`, `failed`, `canceled`, `rejected`
Active states: `submitted`, `working`, `input-required`, `auth-required`

---

#### Task

```typescript
interface Task {
  kind: 'task';
  id: string;
  contextId: string;
  status: TaskStatus;
  history: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

interface TaskStatus {
  state: TaskState;
  message?: Message; // Optional agent message explaining the status
  timestamp: string; // ISO 8601
}
```

---

#### Message and Part Types (v0.3.0)

```typescript
interface Message {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

// Discriminated union by `kind` field
type Part = TextPart | FilePart | DataPart;

interface TextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

interface FilePart {
  kind: 'file';
  file: FileWithUri | FileWithBytes;
  metadata?: Record<string, unknown>;
}

interface FileWithUri {
  uri: string;
  mimeType?: string;
  name?: string;
}

interface FileWithBytes {
  bytes: string; // base64-encoded
  mimeType?: string;
  name?: string;
}

interface DataPart {
  kind: 'data';
  data: Record<string, unknown>; // Structured JSON
  metadata?: Record<string, unknown>;
}
```

**IMPORTANT — v1.0 breaking change:** v1.0 removes the `kind` discriminator and uses member-presence discrimination instead (`"text" in part`). `@a2a-js/sdk` v0.3.13 still uses the `kind` field pattern.

---

#### Update Events (published to ExecutionEventBus)

```typescript
interface TaskStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final: boolean; // true = terminal event (no more events follow)
}

interface TaskArtifactUpdateEvent {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
}

interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}
```

---

### 1.2 Server-Side API

#### AgentExecutor Interface

The core interface to implement with your agent logic:

```typescript
interface AgentExecutor {
  execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void>;

  cancelTask(taskId: string, eventBus?: ExecutionEventBus): Promise<void>;
}
```

#### RequestContext

Contains all state for the current request:

```typescript
class RequestContext {
  taskId: string;
  contextId: string;
  userMessage: Message;
  task: Task | undefined; // undefined on first message in a context
}
```

#### ExecutionEventBus

Publish events during agent execution:

```typescript
interface ExecutionEventBus {
  publish(event: Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent): void;
}
```

#### Full AgentExecutor Implementation Pattern

```typescript
import { v4 as uuidv4 } from 'uuid';
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';

class MyAgentExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, task } = requestContext;
    const taskId = task?.id ?? uuidv4();
    const contextId = userMessage.contextId ?? task?.contextId ?? uuidv4();

    // 1. Publish initial task if new
    if (!task) {
      const initialTask: Task = {
        kind: 'task',
        id: taskId,
        contextId,
        status: {
          state: TaskState.Submitted,
          timestamp: new Date().toISOString(),
        },
        history: [userMessage],
        artifacts: [],
      };
      eventBus.publish(initialTask);
    }

    // 2. Signal working
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: TaskState.Working,
        timestamp: new Date().toISOString(),
      },
      final: false,
    } satisfies TaskStatusUpdateEvent);

    // 3. Do work...
    const result = await this.processMessage(userMessage);

    // 4. Check cancellation
    if (this.cancelledTasks.has(taskId)) {
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: TaskState.Canceled, timestamp: new Date().toISOString() },
        final: true,
      } satisfies TaskStatusUpdateEvent);
      return;
    }

    // 5. Publish final status with response
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: TaskState.Completed,
        message: {
          kind: 'message',
          role: 'agent',
          messageId: uuidv4(),
          parts: [{ kind: 'text', text: result }],
          taskId,
          contextId,
        },
        timestamp: new Date().toISOString(),
      },
      final: true,
    } satisfies TaskStatusUpdateEvent);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelledTasks.add(taskId);
  }

  private async processMessage(msg: Message): Promise<string> {
    const text = msg.parts
      .filter((p): p is TextPart => p.kind === 'text')
      .map((p) => p.text)
      .join('\n');
    return `Processed: ${text}`;
  }
}
```

---

#### DefaultRequestHandler

The orchestrator that wires together the AgentCard, TaskStore, and AgentExecutor:

```typescript
class DefaultRequestHandler {
  constructor(
    agentCard: AgentCard,
    taskStore: TaskStore,
    agentExecutor: AgentExecutor,
    eventBusManager?: ExecutionEventBusManager, // optional
    pushNotificationStore?: PushNotificationStore, // optional
    pushNotificationSender?: PushNotificationSender, // optional
    extendedAgentCard?: ExtendedAgentCardProvider // optional
  );
}
```

#### InMemoryTaskStore

Drop-in task store for development and testing:

```typescript
class InMemoryTaskStore implements TaskStore {
  // No constructor arguments needed
}
```

---

### 1.3 Express Integration

Two patterns are available in v0.3.13:

**Pattern A: A2AExpressApp (simpler, from earlier tutorials — still works)**

```typescript
import express from 'express';
import { A2AExpressApp, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk';

const taskStore = new InMemoryTaskStore();
const agentExecutor = new MyAgentExecutor();
const requestHandler = new DefaultRequestHandler(myAgentCard, taskStore, agentExecutor);

const appBuilder = new A2AExpressApp(requestHandler);
const expressApp = appBuilder.setupRoutes(express(), '');

expressApp.listen(3000, () => {
  console.log('A2A agent running on http://localhost:3000');
  // Agent card at: http://localhost:3000/.well-known/agent.json
});
```

**Pattern B: Granular Handlers (current recommended — from v0.3.x README)**

```typescript
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore, AGENT_CARD_PATH } from '@a2a-js/sdk';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';

const requestHandler = new DefaultRequestHandler(
  myAgentCard,
  new InMemoryTaskStore(),
  new MyAgentExecutor()
);

const app = express();

// Agent card discovery endpoint
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));

// JSON-RPC transport (implements message/send, message/stream, tasks/get, tasks/cancel)
app.use(
  '/a2a/jsonrpc',
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  })
);

// REST transport (optional)
app.use(
  '/a2a/rest',
  restHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  })
);

app.listen(4000);
```

**AGENT_CARD_PATH** constant resolves to `.well-known/agent.json`.

**Mounting in an existing Express app** (DorkOS use case — adding A2A to existing `apps/server`):

```typescript
// In apps/server/src/index.ts or a new route module:
import { Router } from 'express';
import { DefaultRequestHandler, InMemoryTaskStore, AGENT_CARD_PATH } from '@a2a-js/sdk';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

export function createA2ARouter(agentCard: AgentCard, executor: AgentExecutor): Router {
  const router = Router();
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);

  // Mount at /a2a on the DorkOS express app
  router.use(
    `/.well-known/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler })
  );
  router.use(
    '/jsonrpc',
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication })
  );

  return router;
}

// In main Express setup:
app.use('/a2a', createA2ARouter(card, executor));
```

---

### 1.4 JSON-RPC 2.0 Method Reference

All requests use `Content-Type: application/json` and `POST` to the JSON-RPC endpoint.

#### message/send (blocking)

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "message/send",
  "params": {
    "message": {
      "kind": "message",
      "role": "user",
      "messageId": "msg-uuid-001",
      "parts": [{ "kind": "text", "text": "Hello, agent!" }],
      "contextId": "ctx-uuid-001"
    },
    "configuration": {
      "blocking": true,
      "acceptedOutputModes": ["text/plain"]
    }
  }
}
```

Response: `{ "jsonrpc": "2.0", "id": "req-001", "result": { /* Task object */ } }`

#### message/stream (SSE)

Same request format as `message/send`, but the server responds with `Content-Type: text/event-stream`.

Each SSE event:

```
data: {"jsonrpc":"2.0","id":"req-001","result":{"kind":"status-update","taskId":"...","contextId":"...","status":{"state":"working","timestamp":"..."},"final":false}}

data: {"jsonrpc":"2.0","id":"req-001","result":{"kind":"status-update","taskId":"...","contextId":"...","status":{"state":"completed","message":{...},"timestamp":"..."},"final":true}}
```

The final event has `"final": true` in the result.

#### tasks/get

```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "method": "tasks/get",
  "params": {
    "id": "task-uuid-001",
    "historyLength": 5
  }
}
```

Response: `{ "jsonrpc": "2.0", "id": "req-002", "result": { /* Task object */ } }`

#### tasks/cancel

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "method": "tasks/cancel",
  "params": {
    "id": "task-uuid-001"
  }
}
```

Response: `{ "jsonrpc": "2.0", "id": "req-003", "result": { /* Task object with state: "canceled" */ } }`

---

### 1.5 Client-Side API

```typescript
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk';

// Auto-detect transport from AgentCard
const factory = new ClientFactory();
const client = await factory.createFromUrl('http://localhost:4000');

// Or from Agent Card URL directly
const client2 = await factory.createFromAgentCardUrl(
  'http://localhost:4000/.well-known/agent.json'
);

// Send blocking message
const task = await client.sendMessage({
  message: {
    kind: 'message',
    role: 'user',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: 'Hello' }],
  },
});

// Send streaming message
const stream = client.sendMessageStream({
  message: {
    kind: 'message',
    role: 'user',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: 'Hello' }],
  },
});

for await (const event of stream) {
  console.log(event); // TaskStatusUpdateEvent or TaskArtifactUpdateEvent
}
```

**Authentication interceptor (for API key auth):**

```typescript
import {
  ClientFactory,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk';

const factory = new ClientFactory({
  transports: [
    new JsonRpcTransportFactory({
      fetch: createAuthenticatingFetchWithRetry(globalThis.fetch, {
        headers: async () => ({ 'X-API-Key': 'my-secret-key' }),
        shouldRetryWithHeaders: async () => undefined,
      }),
    }),
  ],
});
```

---

### 1.6 Authentication Schemes (AgentCard securitySchemes)

```typescript
// API Key (header)
const apiKeyScheme: APIKeySecurityScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

// Bearer token
const bearerScheme: HTTPAuthSecurityScheme = {
  type: 'http',
  scheme: 'bearer',
};

// OAuth2 Client Credentials
const oauth2Scheme: OAuth2SecurityScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {
      tokenUrl: 'https://auth.example.com/token',
      scopes: { 'agents:invoke': 'Invoke agents' },
    },
  },
};
```

---

### 1.7 v0.3.0 → v1.0 Breaking Changes (Critical for Future-Proofing)

`@a2a-js/sdk` v0.3.13 implements spec v0.3.0. The v1.0 spec introduces the following breaking changes that DorkOS code must NOT depend on yet:

| Dimension               | v0.3.0 (current SDK)                      | v1.0 (future)                                          |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Task states             | `"submitted"`, `"working"`, `"completed"` | `"TASK_STATE_SUBMITTED"`, `"TASK_STATE_WORKING"`, etc. |
| Part discrimination     | `kind: "text" \| "file" \| "data"`        | Member presence (`"text" in part`)                     |
| Message roles           | `"user"`, `"agent"`                       | `"ROLE_USER"`, `"ROLE_AGENT"`                          |
| Method names            | `message/send`, `tasks/get`               | `SendMessage`, `GetTask`                               |
| AgentCard top-level url | `url` field                               | Moved into `supportedInterfaces[]`                     |
| `final` field on events | Present                                   | Removed                                                |
| `kind` on events        | Present                                   | Removed                                                |

---

## Part 2: Claude Code Channels MCP Protocol

### Overview

Claude Code Channels is a **research preview** feature (Claude Code v2.1.80+, March 2026) that allows MCP servers to push events into a running Claude Code session over stdio. It is built on standard MCP — the only additions are a capability declaration and a notification method.

**Requirements:**

- Claude Code v2.1.80+
- `@modelcontextprotocol/sdk` (standard MCP SDK)
- claude.ai login (NOT Console or API key auth)
- `--dangerously-load-development-channels` for custom channels during preview

---

### 2.1 MCP Capability Declaration

A channel declares itself by adding `experimental['claude/channel']` to the Server capabilities:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const mcp = new Server(
  { name: 'my-channel', version: '0.0.1' },
  {
    capabilities: {
      // REQUIRED: Presence registers the notification listener in Claude Code.
      // Value is always {} — the key's presence is what matters.
      experimental: { 'claude/channel': {} },

      // OPTIONAL: Include only if this is a two-way channel with a reply tool
      tools: {},
    },
    // RECOMMENDED: Added verbatim to Claude's system prompt.
    // Tell Claude what events to expect and how to respond.
    instructions: 'Events arrive as <channel source="my-channel" ...>. Act on them.',
  }
);

await mcp.connect(new StdioServerTransport());
```

---

### 2.2 Notification Format (`notifications/claude/channel`)

Emitting an event to the Claude session:

```typescript
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    // REQUIRED: The event body. Delivered as the inner text of the <channel> tag.
    content: 'build failed on main: https://ci.example.com/run/1234',

    // OPTIONAL: Each key-value pair becomes an XML attribute on the <channel> tag.
    // Key constraint: letters, digits, and underscores ONLY.
    // Keys with hyphens or other characters are SILENTLY DROPPED.
    meta: {
      severity: 'high',
      run_id: '1234',
      chat_id: 'user-telegram-id', // for routing replies back
    },
  },
});
```

**Wire format — how Claude receives it:**

The notification is wrapped in an XML `<channel>` tag before being injected into Claude's context:

```xml
<channel source="my-channel" severity="high" run_id="1234" chat_id="user-telegram-id">
build failed on main: https://ci.example.com/run/1234
</channel>
```

The `source` attribute is set automatically to the MCP Server's `name` value.

---

### 2.3 Reply Tool (`relay_reply` pattern)

For two-way channels, expose a standard MCP tool. Nothing about the tool registration
is channel-specific — it is standard MCP tool handling:

```typescript
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Claude queries this at startup to discover available tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'relay_reply',
      description: 'Send a message back through the DorkOS Relay to the originating agent or user',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'The conversation/subject to reply to (from the channel tag attribute)',
          },
          text: {
            type: 'string',
            description: 'The reply message text',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}));

// Claude calls this when it wants to invoke the tool
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'relay_reply') {
    const { chat_id, text } = req.params.arguments as {
      chat_id: string;
      text: string;
    };

    // Publish back to DorkOS Relay
    await relayCore.publish({
      subject: chat_id,
      payload: { type: 'text', content: text },
    });

    return {
      content: [{ type: 'text', text: 'sent' }],
    };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});
```

---

### 2.4 .mcp.json Configuration Format

Channel plugins are registered in `.mcp.json` at the project root or `~/.claude.json` for user-level:

```json
{
  "mcpServers": {
    "dorkos-relay": {
      "command": "node",
      "args": ["./dist/channel-plugin.js"]
    }
  }
}
```

For Bun-based plugins:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bun",
      "args": ["./telegram-channel.ts"]
    }
  }
}
```

Claude Code reads this config at startup and spawns each server as a subprocess. The server communicates with Claude Code over stdio.

---

### 2.5 How Claude Code Discovers and Spawns Channel Plugins

1. Claude Code reads `.mcp.json` at session start
2. For each entry in `mcpServers`, Claude Code spawns the command as a subprocess
3. Claude Code connects to the subprocess over stdio (parent writes to child stdin, reads from child stdout)
4. During MCP `initialize` handshake, Claude Code checks for `capabilities.experimental['claude/channel']`
5. If present, Claude Code registers a notification listener for `notifications/claude/channel` on that server
6. Claude Code also fetches `tools/list` from the server and surfaces those tools in the session (this is where bug #37072 currently fails)

**Activation at runtime:**

```bash
# Use Anthropic-approved plugins:
claude --channels plugin:telegram@claude-plugins-official

# Use custom/development channel (bypasses allowlist, requires confirmation):
claude --dangerously-load-development-channels server:dorkos-relay
```

---

### 2.6 Known Bugs (Research Preview — March 2026)

#### Bug #36800: Duplicate Plugin Instance Spawn

**Status:** Open. No harness-side fix scheduled.

**Symptom:** Claude Code's harness spawns a second instance of the channel plugin approximately 2-5 minutes into a healthy session, with no preceding error. The second instance has a different PID but runs the same code.

**Cascade failure sequence:**

1. Two instances attempt to share the same external resource (e.g., Telegram `getUpdates`)
2. The service returns a conflict error (409) to the original instance
3. The original instance's connection breaks
4. The harness kills the new instance's stdin
5. MCP tools disappear from the session (`Error: No such tool available: mcp__plugin_xxx__reply`)

**Impact:** Any channel plugin with exclusive external resources is broken after ~3 minutes. The failure is silent — Claude reports that the tool is unavailable.

**Workarounds (plugin-side mitigations, not a fix):**

- Handle 409 and similar conflict errors gracefully with retry
- Listen for `stdin` close/end events and exit cleanly (`process.exit(0)`)
- Handle `SIGTERM` to allow graceful shutdown
- Add startup logging to detect if another instance is already running

**What is NOT fixed by plugin-side mitigations:** The harness will still spawn the duplicate. Tool registrations are still lost after the churn.

#### Bug #37072: Channel Plugin MCP Tools Not Surfaced

**Status:** Open.

**Symptom:** When using `--channels`, the MCP server connects successfully and its `instructions` string appears in Claude's system-reminder — confirming the stdio connection is live. However, the tools exposed via `tools/list` are never made available to Claude. They are absent from the direct tool list and not findable via ToolSearch even with `tengu_mcp_tool_search: true`.

**What does work:** Inbound `notifications/claude/channel` events are received and injected as `<channel>` tags correctly. Only tool surfacing is broken.

**Affected operations:** Any two-way channel interaction where Claude needs to call `relay_reply`, `react`, `edit_message`, or any other tool from the channel plugin.

**Workaround:** None known at time of writing. This is a fundamental blocker for two-way channels. One-way channels (push only, no reply needed) work correctly.

---

### 2.7 Complete Channel Plugin Template

```typescript
#!/usr/bin/env bun
// dorkos-relay-channel.ts — DorkOS Channel Plugin for Claude Code
// Bridges DorkOS Relay messages into active Claude Code sessions

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const CHANNEL_NAME = 'dorkos-relay';

const mcp = new Server(
  { name: CHANNEL_NAME, version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {}, // enables reply tool discovery (blocked by #37072 currently)
    },
    instructions: [
      'DorkOS Relay messages arrive as <channel source="dorkos-relay" subject="..." from="...">.',
      'The subject is the relay subject the message came from.',
      'To reply, call relay_reply with the subject and your response text.',
    ].join(' '),
  }
);

// Tool: relay_reply
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'relay_reply',
      description: 'Publish a reply message back through DorkOS Relay',
      inputSchema: {
        type: 'object' as const,
        properties: {
          subject: {
            type: 'string',
            description: 'The relay subject to publish to (from the channel tag)',
          },
          text: {
            type: 'string',
            description: 'The reply message text',
          },
        },
        required: ['subject', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'relay_reply') {
    const { subject, text } = req.params.arguments as {
      subject: string;
      text: string;
    };
    // TODO: connect to DorkOS relay and publish
    // await relayClient.publish(subject, { type: 'text', content: text });
    console.error(`[relay_reply] subject=${subject} text=${text}`);
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

// Graceful shutdown (mitigates bug #36800 cascade)
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));

await mcp.connect(new StdioServerTransport());

// Subscribe to DorkOS Relay and forward messages as channel events
// TODO: Connect to relay and push:
// relayClient.subscribe('relay.agent.my-session', async (envelope) => {
//   await mcp.notification({
//     method: 'notifications/claude/channel',
//     params: {
//       content: envelope.payload.content,
//       meta: {
//         subject: envelope.subject,
//         from: envelope.from ?? 'unknown',
//       },
//     },
//   });
// });
```

---

## Part 3: A2A Agent Card Schema — Authoritative Reference

The Agent Card is the external discovery document served at `GET /.well-known/agent.json`.

### Required Fields (v0.3.0)

| Field                | Type                | Description                        |
| -------------------- | ------------------- | ---------------------------------- |
| `name`               | `string`            | Human-readable agent name          |
| `description`        | `string`            | What the agent does                |
| `url`                | `string`            | Primary A2A endpoint URL           |
| `version`            | `string`            | Agent version (semver recommended) |
| `protocolVersion`    | `string`            | Always `"0.3.0"` for current SDK   |
| `capabilities`       | `AgentCapabilities` | Feature support flags              |
| `skills`             | `AgentSkill[]`      | At least one skill required        |
| `defaultInputModes`  | `string[]`          | MIME types accepted                |
| `defaultOutputModes` | `string[]`          | MIME types produced                |

### Optional Fields (v0.3.0)

| Field                               | Type                                     | Description                               |
| ----------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `provider`                          | `{ organization: string; url?: string }` | Who built this agent                      |
| `iconUrl`                           | `string`                                 | URL to agent icon                         |
| `documentationUrl`                  | `string`                                 | Human-readable docs URL                   |
| `preferredTransport`                | `string`                                 | `"JSONRPC"` (default), `"REST"`, `"GRPC"` |
| `additionalInterfaces`              | `AgentInterface[]`                       | Alternate transport/URL pairs             |
| `securitySchemes`                   | `Record<string, SecurityScheme>`         | Auth scheme definitions                   |
| `security`                          | `SecurityRequirement[]`                  | Which schemes are required                |
| `supportsAuthenticatedExtendedCard` | `boolean`                                | Extended card available behind auth       |
| `signatures`                        | `AgentCardSignature[]`                   | JWS signatures (RFC 7515) for integrity   |

### AgentSkill Fields

| Field         | Type       | Required                              |
| ------------- | ---------- | ------------------------------------- |
| `id`          | `string`   | Yes                                   |
| `name`        | `string`   | Yes                                   |
| `description` | `string`   | Yes                                   |
| `tags`        | `string[]` | Yes                                   |
| `examples`    | `string[]` | No                                    |
| `inputModes`  | `string[]` | No (defaults to `defaultInputModes`)  |
| `outputModes` | `string[]` | No (defaults to `defaultOutputModes`) |

### Capabilities Object

```typescript
interface AgentCapabilities {
  streaming: boolean; // SSE streaming support (message/stream)
  pushNotifications: boolean; // WebHook push support
  stateTransitionHistory?: boolean; // Whether task history is preserved
}
```

### Authentication Scheme Types

```typescript
// API key in header
{ type: 'apiKey', in: 'header', name: 'X-API-Key' }
// API key in query param
{ type: 'apiKey', in: 'query', name: 'api_key' }
// Bearer token
{ type: 'http', scheme: 'bearer', bearerFormat?: 'JWT' }
// Basic auth
{ type: 'http', scheme: 'basic' }
// OAuth2
{ type: 'oauth2', flows: { clientCredentials: { tokenUrl: '...', scopes: {} } } }
// OIDC
{ type: 'openIdConnect', openIdConnectUrl: '...' }
// mTLS
{ type: 'mutualTLS' }
```

### DorkOS Agent Card Mapping (Mesh → A2A)

Mapping DorkOS Mesh agent manifests to A2A Agent Cards:

```typescript
function meshManifestToAgentCard(manifest: AgentManifest, dorkosBaseUrl: string): AgentCard {
  return {
    name: manifest.name,
    description: `DorkOS agent: ${manifest.description ?? manifest.name}`,
    url: `${dorkosBaseUrl}/a2a`,
    protocolVersion: '0.3.0',
    version: manifest.version ?? '1.0.0',
    provider: { organization: 'DorkOS' },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: (manifest.capabilities ?? []).map((cap) => ({
      id: cap,
      name: cap,
      description: `Agent capability: ${cap}`,
      tags: [cap],
    })),
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    security: [{ apiKey: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}
```

---

## Research Gaps and Limitations

1. **@a2a-js/sdk v1.0 migration path** — v1.0 spec is available but the SDK has not yet
   fully migrated. The exact release timeline for a v1.0-compliant SDK is not documented.
   Check https://github.com/a2aproject/a2a-js/blob/main/CHANGELOG.md before upgrading.

2. **A2AExpressApp status in latest version** — Some sources use `A2AExpressApp` while
   the README shows the granular `agentCardHandler`/`jsonRpcHandler` pattern. The old
   API appears to still work but may be internally deprecated. Prefer the granular pattern.

3. **Bug #36800 fix timeline** — The Claude Code harness-side fix has no scheduled PR.
   The plugin-side PRs (#812, #813, #814) address symptoms only. No ETA available.

4. **Bug #37072 root cause** — The exact cause of tools not being surfaced is undocumented.
   Workaround: None available for two-way channels.

5. **Channel allowlist process** — To get a custom channel on the approved allowlist
   (removing the need for `--dangerously-load-development-channels`), a formal submission
   to Anthropic's official marketplace is required. Process and timeline undocumented.

---

## Contradictions and Notes

- The `A2AExpressApp.setupRoutes()` pattern vs. `agentCardHandler`/`jsonRpcHandler`
  pattern: both are functional in v0.3.13. The README uses the granular handlers. Tutorials
  use `A2AExpressApp`. For DorkOS integration, prefer the granular pattern as it integrates
  more naturally with an existing Express app.

- The A2A specification site at `a2a-protocol.org/latest/` currently shows v1.0 spec
  content, not v0.3.0. The SDK at v0.3.13 implements v0.3.0. Use
  `a2a-protocol.org/v0.3.0/specification/` for the spec that matches the current SDK.

- `TaskState` in the SDK is an enum import. Always import from the SDK rather than
  using raw strings to stay migration-safe:
  `import { TaskState } from '@a2a-js/sdk'`

---

## Sources and Evidence

- [@a2a-js/sdk npm page](https://www.npmjs.com/package/@a2a-js/sdk) — version 0.3.13
- [a2aproject/a2a-js GitHub](https://github.com/a2aproject/a2a-js) — README and source
- [a2a-js CHANGELOG.md](https://github.com/a2aproject/a2a-js/blob/main/CHANGELOG.md) — version history
- [A2A Protocol v0.3.0 Specification](https://a2a-protocol.org/v0.3.0/specification/) — normative reference
- [A2A Protocol v1.0 What's New](https://a2a-protocol.org/latest/whats-new-v1/) — breaking changes
- [A2A JS SDK Tutorial (DEV.to)](https://dev.to/czmilo/a2a-js-sdk-complete-tutorial-quick-start-guide-41d2) — complete code examples
- [A2AProtocol.ai JS SDK Guide](https://a2aprotocol.ai/docs/guide/a2a-javascript-sdk) — DefaultRequestHandler patterns
- [Claude Code Channels Reference](https://code.claude.com/docs/en/channels-reference) — official spec for notifications/claude/channel
- [GitHub #36800 — Duplicate plugin spawn](https://github.com/anthropics/claude-code/issues/36800) — full bug report
- [GitHub #37072 — Tools not surfaced](https://github.com/anthropics/claude-code/issues/37072) — full bug report
- [claude-plugins-official repository](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins) — reference implementations
- Prior internal research: `research/20260321_claude_code_channels_a2a_protocol_comparison.md`

---

## Search Methodology

- Searches performed: 18
- Most productive terms: "a2a-js sdk agentCardHandler jsonRpcHandler", "notifications/claude/channel MCP notification format", "@a2a-js/sdk 0.3.13 express", "A2A protocol v0.3.0 specification AgentCard schema"
- Primary sources: GitHub a2aproject/a2a-js, code.claude.com/docs, a2a-protocol.org/v0.3.0
- Direct source code accessed: server/index.ts exports list via GitHub raw URLs
- Official docs fetched: Claude Code Channels Reference (full content), A2A spec v0.3.0
