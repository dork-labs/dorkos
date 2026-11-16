# Task Breakdown: Claude Code WebUI & Reusable API v1

Generated: 2026-02-06
Source: gateway/specs/claude-code-webui-api/02-specification.md
Last Decompose: 2026-02-06

## Overview

Build a web-based interface for Claude Code backed by a channel-agnostic REST/SSE API. The system lives entirely in `gateway/` as a single TypeScript package with `src/server/`, `src/client/`, and `src/shared/` directories. It provides chat with streaming responses, inline tool call visualization, slash command auto-complete, session continuity, and per-session permission control.

---

## Phase 1: Server Foundation

### Task 1.1: Initialize gateway project with dependencies and configuration

**Description**: Set up the `gateway/` TypeScript project with all required dependencies, TypeScript config, environment variables, and npm scripts.
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None (must be first)

**Technical Requirements**:

Create the `gateway/` directory at the vault root with the following structure:

```
gateway/
├── src/
│   ├── server/
│   │   ├── index.ts
│   │   ├── routes/
│   │   ├── services/
│   │   ├── middleware/
│   │   └── types.ts
│   ├── client/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── stores/
│   │   ├── lib/
│   │   └── index.css
│   └── shared/
│       └── types.ts
├── public/
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
├── tailwind.config.ts
├── components.json
└── .env
```

**package.json**:

```json
{
  "name": "dorkos",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "concurrently \"tsx watch src/server/index.ts\" \"vite\"",
    "dev:server": "tsx watch src/server/index.ts",
    "dev:client": "vite",
    "build": "tsc -p tsconfig.server.json && vite build",
    "start": "NODE_ENV=production node dist-server/server/index.js",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "gray-matter": "^4.0.3",
    "uuid": "^10.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@tanstack/react-virtual": "^3.11.0",
    "@tanstack/react-query": "^5.62.0",
    "zustand": "^5.0.0",
    "cmdk": "^1.0.0",
    "streamdown": "latest",
    "lucide-react": "latest"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "latest",
    "typescript": "^5.7.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/express": "^5.0.0",
    "@types/cors": "^2.8.0",
    "@types/uuid": "^10.0.0",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "tsx": "^4.19.0",
    "concurrently": "^9.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
```

**tsconfig.json** (shared base):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "paths": {
      "@/*": ["./src/client/*"],
      "@shared/*": ["./src/shared/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "dist-server"]
}
```

**tsconfig.server.json**:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-server",
    "module": "ESNext",
    "moduleResolution": "bundler"
  },
  "include": ["src/server/**/*", "src/shared/**/*"]
}
```

**.env**:

```
GATEWAY_PORT=42420
```

**Implementation Steps**:

1. Create `gateway/` directory at vault root
2. Write `package.json` with all backend and frontend dependencies
3. Write `tsconfig.json` (shared base) and `tsconfig.server.json` (server-specific)
4. Write `.env` with `GATEWAY_PORT=42420`
5. Create all subdirectories in `src/server/`, `src/client/`, `src/shared/`
6. Create placeholder `public/` directory
7. Run `npm install` to install all dependencies
8. Verify TypeScript compilation works with `npx tsc --noEmit`

**Acceptance Criteria**:

- [ ] `gateway/` directory exists at vault root
- [ ] `npm install` completes without errors
- [ ] `npx tsc --noEmit` completes without errors
- [ ] All subdirectories from architecture exist
- [ ] `.env` contains `GATEWAY_PORT=42420`
- [ ] Both tsconfig files present and valid

---

### Task 1.2: Implement shared types (`src/shared/types.ts`)

**Description**: Create the shared type definitions used by both server and client for API contracts, session management, streaming events, and command registry.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Implementation** - Create `gateway/src/shared/types.ts`:

```typescript
// === Session Types ===

export interface Session {
  id: string;
  sdkSessionId?: string; // Claude Agent SDK session ID
  title: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  lastMessagePreview?: string; // First 100 chars of last message
  permissionMode: 'default' | 'dangerously-skip';
}

export interface CreateSessionRequest {
  title?: string;
  permissionMode?: 'default' | 'dangerously-skip';
}

export interface SendMessageRequest {
  content: string;
}

// === Message Types (SSE stream events) ===

export type StreamEventType =
  | 'text_delta' // Incremental text chunk
  | 'tool_call_start' // Tool execution begins
  | 'tool_call_delta' // Tool input streaming
  | 'tool_call_end' // Tool execution finished
  | 'tool_result' // Tool returned a result
  | 'approval_required' // Tool needs user approval
  | 'error' // Error occurred
  | 'done'; // Stream complete

export interface StreamEvent {
  type: StreamEventType;
  data: TextDelta | ToolCallEvent | ApprovalEvent | ErrorEvent | DoneEvent;
}

export interface TextDelta {
  text: string;
}

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input?: string; // JSON string of tool input
  result?: string; // Tool result (for tool_result type)
  status: 'pending' | 'running' | 'complete' | 'error';
}

export interface ApprovalEvent {
  toolCallId: string;
  toolName: string;
  input: string; // JSON string of proposed tool input
}

export interface ErrorEvent {
  message: string;
  code?: string;
}

export interface DoneEvent {
  sessionId: string;
  sdkSessionId: string;
}

// === Command Types ===

export interface CommandEntry {
  namespace: string;
  command: string;
  fullCommand: string; // "/namespace:command"
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  filePath: string;
}

export interface CommandRegistry {
  commands: CommandEntry[];
  lastScanned: string; // ISO timestamp
}
```

**Acceptance Criteria**:

- [ ] File exists at `gateway/src/shared/types.ts`
- [ ] All interfaces from spec are present: Session, CreateSessionRequest, SendMessageRequest, StreamEvent, StreamEventType, TextDelta, ToolCallEvent, ApprovalEvent, ErrorEvent, DoneEvent, CommandEntry, CommandRegistry
- [ ] TypeScript compiles without errors
- [ ] Types are exportable and importable from both server and client code

---

### Task 1.3: Implement session store service (`src/server/services/session-store.ts`)

**Description**: Build the lightweight JSON file-based session persistence store that saves session metadata to `gateway/state/sessions.json`.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.4, Task 1.5

**Implementation** - Create `gateway/src/server/services/session-store.ts`:

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { Session } from '../../shared/types';

const STORE_PATH = path.join(process.cwd(), 'state', 'sessions.json');

class SessionStore {
  private sessions: Map<string, Session> = new Map();

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(STORE_PATH, 'utf-8');
      const parsed: Session[] = JSON.parse(data);
      this.sessions = new Map(parsed.map((s) => [s.id, s]));
    } catch {
      this.sessions = new Map();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    const data = Array.from(this.sessions.values());
    await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2));
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async set(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
    await this.save();
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.sessions.delete(id);
    if (existed) await this.save();
    return existed;
  }
}

export const sessionStore = new SessionStore();
```

**Unit Tests** - Create `gateway/src/server/services/__tests__/session-store.test.ts`:

Test cases:

1. `load()` with empty/missing file initializes empty map
2. `load()` with corrupt JSON initializes empty map
3. `set()` persists session and `get()` retrieves it
4. `list()` returns sessions sorted by updatedAt descending
5. `delete()` removes session and returns true; returns false for missing
6. `save()` creates `state/` directory if missing
7. Round-trip: set multiple sessions, save, load, verify all present

**Acceptance Criteria**:

- [ ] SessionStore class implemented with load, save, list, get, set, delete methods
- [ ] Persists to `gateway/state/sessions.json`
- [ ] Auto-creates `state/` directory on save
- [ ] Gracefully handles missing or corrupt JSON files
- [ ] Sessions sorted by updatedAt descending in list()
- [ ] All unit tests pass

---

### Task 1.4: Implement SSE stream adapter (`src/server/services/stream-adapter.ts`)

**Description**: Build the Server-Sent Events adapter that translates StreamEvent objects into properly formatted SSE responses.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.3, Task 1.5

**Implementation** - Create `gateway/src/server/services/stream-adapter.ts`:

```typescript
import type { Response } from 'express';
import type { StreamEvent } from '../../shared/types';

export function initSSEStream(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });
}

export function sendSSEEvent(res: Response, event: StreamEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export function endSSEStream(res: Response): void {
  res.end();
}
```

**Unit Tests** - Create `gateway/src/server/services/__tests__/stream-adapter.test.ts`:

Test cases:

1. `initSSEStream()` sets correct headers (Content-Type, Cache-Control, Connection, X-Accel-Buffering)
2. `sendSSEEvent()` formats event with `event:` and `data:` lines followed by double newline
3. `sendSSEEvent()` properly JSON-serializes event data
4. `endSSEStream()` calls `res.end()`
5. Multiple events sent in sequence produce correct SSE format

**Acceptance Criteria**:

- [ ] Three exported functions: initSSEStream, sendSSEEvent, endSSEStream
- [ ] SSE format: `event: <type>\ndata: <json>\n\n`
- [ ] Headers include Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive
- [ ] X-Accel-Buffering: no header present (nginx proxy support)
- [ ] All unit tests pass

---

### Task 1.5: Implement health route and error handler middleware

**Description**: Create the health check endpoint and global error handling middleware.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.3, Task 1.4

**Implementation** - Create `gateway/src/server/routes/health.ts`:

```typescript
import { Router } from 'express';
const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

export default router;
```

**Implementation** - Create `gateway/src/server/middleware/error-handler.ts`:

```typescript
import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[Gateway Error]', err.message, err.stack);
  res.status(500).json({
    error: err.message || 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
```

**Acceptance Criteria**:

- [ ] GET /api/health returns `{ status: 'ok', version: '1.0.0', uptime: <number> }`
- [ ] Error handler catches unhandled errors and returns 500 with JSON body
- [ ] Error handler logs to console with stack trace
- [ ] Both files export their respective routers/middleware

---

### Task 1.6: Implement server entry point with Express setup (`src/server/index.ts`)

**Description**: Create the main Express server that wires routes, middleware, static serving, and startup.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3, Task 1.4, Task 1.5

**Implementation** - Create `gateway/src/server/index.ts`:

```typescript
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import sessionRoutes from './routes/sessions';
import commandRoutes from './routes/commands';
import healthRoutes from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { sessionStore } from './services/session-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const PORT = parseInt(process.env.GATEWAY_PORT || '42420', 10);
const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/sessions', sessionRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/health', healthRoutes);

// Error handler (must be after routes)
app.use(errorHandler);

// In production, serve the built React app
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../../dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

async function start() {
  await sessionStore.load();
  app.listen(PORT, 'localhost', () => {
    console.log(`Gateway server running on http://localhost:${PORT}`);
  });
}

start();
```

**Key Details**:

- Server binds to `localhost` only (security: not `0.0.0.0`)
- Loads `.env` from gateway root
- Registers routes under `/api/` prefix
- Serves React build in production mode
- Loads session store on startup

**Acceptance Criteria**:

- [ ] Server starts and listens on port from GATEWAY_PORT env var (default 42420)
- [ ] Server binds to localhost only
- [ ] CORS middleware active
- [ ] JSON body parsing active
- [ ] Routes mounted: /api/sessions, /api/commands, /api/health
- [ ] Error handler registered after routes
- [ ] Session store loaded on startup
- [ ] Production mode serves static files from dist/
- [ ] `npm run dev:server` starts the server successfully

---

## Phase 2: SDK Integration & Chat Streaming

### Task 2.1: Implement agent manager service (`src/server/services/agent-manager.ts`)

**Description**: Build the core agent manager wrapping the Claude Agent SDK for session lifecycle, message streaming, and memory management.
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.2, Task 1.4

**Implementation** - Create `gateway/src/server/services/agent-manager.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Session, StreamEvent } from '../../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AgentSession {
  sdkSessionId: string;
  createdAt: number;
  lastActivity: number;
  permissionMode: 'default' | 'dangerously-skip';
  pendingApproval?: {
    toolCallId: string;
    resolve: (approved: boolean) => void;
  };
}

class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  async createSession(
    sessionId: string,
    opts: {
      permissionMode: 'default' | 'dangerously-skip';
    }
  ): Promise<string> {
    // Will be populated on first message
    this.sessions.set(sessionId, {
      sdkSessionId: '',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      permissionMode: opts.permissionMode,
    });
    return sessionId;
  }

  async *sendMessage(sessionId: string, content: string): AsyncGenerator<StreamEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.lastActivity = Date.now();

    // Resolve vault root (gateway/ is inside the vault root)
    const vaultRoot = path.resolve(__dirname, '../../../../');
    const sdkOptions: Record<string, unknown> = {
      cwd: vaultRoot,
      includePartialMessages: true,
      settingSources: ['project', 'user'],
      plugins: [{ type: 'local', path: '.claude' }],
    };

    // Resume existing session or start new
    if (session.sdkSessionId) {
      sdkOptions.resume = session.sdkSessionId;
    }

    // Permission mode
    if (session.permissionMode === 'dangerously-skip') {
      sdkOptions.permissionMode = 'dangerously-skip';
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    // Stream SDK messages and translate to our event format
    const agentQuery = query({ prompt: content, options: sdkOptions });

    let inTool = false;
    let currentToolName = '';
    let currentToolId = '';

    for await (const message of agentQuery) {
      // Capture session ID from init
      if (message.type === 'system' && message.subtype === 'init') {
        session.sdkSessionId = message.session_id;
      }

      // Handle streaming events
      if (message.type === 'stream_event') {
        const event = message.event;

        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            inTool = true;
            currentToolName = event.content_block.name;
            currentToolId = event.content_block.id;
            yield {
              type: 'tool_call_start',
              data: {
                toolCallId: currentToolId,
                toolName: currentToolName,
                status: 'running',
              },
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && !inTool) {
            yield { type: 'text_delta', data: { text: event.delta.text } };
          } else if (event.delta.type === 'input_json_delta' && inTool) {
            yield {
              type: 'tool_call_delta',
              data: {
                toolCallId: currentToolId,
                toolName: currentToolName,
                input: event.delta.partial_json,
                status: 'running',
              },
            };
          }
        } else if (event.type === 'content_block_stop') {
          if (inTool) {
            yield {
              type: 'tool_call_end',
              data: {
                toolCallId: currentToolId,
                toolName: currentToolName,
                status: 'complete',
              },
            };
            inTool = false;
          }
        }
      }

      // Handle tool results
      if (message.type === 'tool_result') {
        yield {
          type: 'tool_result',
          data: {
            toolCallId: message.tool_use_id,
            toolName: message.tool_name || '',
            result: JSON.stringify(message.content),
            status: 'complete',
          },
        };
      }

      // Handle completion
      if (message.type === 'result') {
        yield {
          type: 'done',
          data: {
            sessionId,
            sdkSessionId: session.sdkSessionId,
          },
        };
      }
    }
  }

  // Approve or deny a pending tool call
  approveTool(sessionId: string, _toolCallId: string, approved: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingApproval) return false;
    session.pendingApproval.resolve(approved);
    session.pendingApproval = undefined;
    return true;
  }

  // Memory management: clean up stale sessions
  checkSessionHealth(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        // Session will auto-resume on next message via SDK resume
        this.sessions.delete(id);
      }
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

export const agentManager = new AgentManager();
```

**Key Details**:

- Vault root resolved using `path.resolve(__dirname, '../../../../')` to go from `src/server/services/` up to the vault root
- SESSION_TIMEOUT_MS = 30 minutes (to prevent 400MB -> 4GB memory leak)
- SDK resume used for session continuity
- `dangerously-skip` mode passes both `permissionMode` and `allowDangerouslySkipPermissions`
- Tool approval uses Promise-based queue pattern (pendingApproval field)

**Acceptance Criteria**:

- [ ] AgentManager class with createSession, sendMessage (async generator), approveTool, checkSessionHealth methods
- [ ] sendMessage yields StreamEvent objects matching the shared types
- [ ] SDK options correctly set cwd to vault root
- [ ] Session resume works via sdkSessionId
- [ ] Permission mode correctly configured for both default and dangerously-skip
- [ ] Session timeout cleanup after 30 minutes of inactivity
- [ ] Exported as singleton `agentManager`

---

### Task 2.2: Implement sessions route (`src/server/routes/sessions.ts`)

**Description**: Build all session API endpoints: create, list, get, delete, send message (SSE streaming), approve tool call, deny tool call.
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 1.3, Task 1.6

**Implementation** - Create `gateway/src/server/routes/sessions.ts`:

```typescript
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { agentManager } from '../services/agent-manager';
import { sessionStore } from '../services/session-store';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../services/stream-adapter';

const router = Router();

// POST /api/sessions - Create new session
router.post('/', async (req, res) => {
  const { title, permissionMode = 'default' } = req.body;
  const id = uuid();
  const session = {
    id,
    title: title || `Session ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode,
  };
  await sessionStore.set(session);
  await agentManager.createSession(id, { permissionMode });
  res.json(session);
});

// GET /api/sessions - List sessions
router.get('/', (_req, res) => {
  res.json(sessionStore.list());
});

// GET /api/sessions/:id - Get session details
router.get('/:id', (req, res) => {
  const session = sessionStore.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// DELETE /api/sessions/:id - Delete session
router.delete('/:id', async (req, res) => {
  const deleted = await sessionStore.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// POST /api/sessions/:id/messages - Send message (SSE stream response)
router.post('/:id/messages', async (req, res) => {
  const session = sessionStore.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  initSSEStream(res);

  try {
    for await (const event of agentManager.sendMessage(session.id, content)) {
      sendSSEEvent(res, event);
    }
  } catch (err) {
    sendSSEEvent(res, {
      type: 'error',
      data: { message: err instanceof Error ? err.message : 'Unknown error' },
    });
  } finally {
    // Update session metadata
    session.updatedAt = new Date().toISOString();
    session.lastMessagePreview = content.slice(0, 100);
    await sessionStore.set(session);
    endSSEStream(res);
  }
});

// POST /api/sessions/:id/approve - Approve pending tool call
router.post('/:id/approve', async (req, res) => {
  const { toolCallId } = req.body;
  const approved = agentManager.approveTool(req.params.id, toolCallId, true);
  if (!approved) return res.status(404).json({ error: 'No pending approval' });
  res.json({ ok: true });
});

// POST /api/sessions/:id/deny - Deny pending tool call
router.post('/:id/deny', async (req, res) => {
  const { toolCallId } = req.body;
  const denied = agentManager.approveTool(req.params.id, toolCallId, false);
  if (!denied) return res.status(404).json({ error: 'No pending approval' });
  res.json({ ok: true });
});

export default router;
```

**API Endpoints**:

| Method | Endpoint                   | Description         | Response                  |
| ------ | -------------------------- | ------------------- | ------------------------- |
| POST   | /api/sessions              | Create new session  | Session JSON              |
| GET    | /api/sessions              | List all sessions   | Session[] JSON            |
| GET    | /api/sessions/:id          | Get session details | Session JSON              |
| DELETE | /api/sessions/:id          | Delete session      | { ok: true }              |
| POST   | /api/sessions/:id/messages | Send message        | SSE stream of StreamEvent |
| POST   | /api/sessions/:id/approve  | Approve tool call   | { ok: true }              |
| POST   | /api/sessions/:id/deny     | Deny tool call      | { ok: true }              |

**Acceptance Criteria**:

- [ ] POST /api/sessions creates a session with UUID, stores in session store and agent manager
- [ ] GET /api/sessions returns all sessions sorted by updatedAt
- [ ] GET /api/sessions/:id returns session or 404
- [ ] DELETE /api/sessions/:id removes session or 404
- [ ] POST /api/sessions/:id/messages streams SSE events for the agent response
- [ ] POST /api/sessions/:id/messages updates session metadata (updatedAt, lastMessagePreview)
- [ ] POST /api/sessions/:id/approve resolves pending tool approval
- [ ] POST /api/sessions/:id/deny rejects pending tool approval
- [ ] Error handling: missing session returns 404, missing content returns 400
- [ ] SSE stream errors are sent as error events before stream closes

---

### Task 2.3: Write server unit and integration tests

**Description**: Test session store CRUD, SSE formatting, and session route behavior.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.2

**Test Files to Create**:

1. `gateway/src/server/services/__tests__/session-store.test.ts`
2. `gateway/src/server/services/__tests__/stream-adapter.test.ts`
3. `gateway/src/server/routes/__tests__/sessions.test.ts`
4. `gateway/src/server/routes/__tests__/health.test.ts`

**Session Store Tests**:

- Load from empty/missing file
- Load from corrupt JSON
- CRUD operations (set, get, list, delete)
- List returns sorted by updatedAt descending
- Delete returns false for non-existent session
- Auto-creates state directory

**Stream Adapter Tests**:

- initSSEStream sets correct headers
- sendSSEEvent produces correct SSE format
- Multiple events produce correct format
- endSSEStream calls res.end()

**Sessions Route Tests** (integration):

- POST /api/sessions creates session
- GET /api/sessions lists sessions
- GET /api/sessions/:id returns specific session
- DELETE /api/sessions/:id removes session
- POST /api/sessions/:id/messages returns 404 for unknown session
- POST /api/sessions/:id/messages returns 400 for missing content

**Health Route Tests**:

- GET /api/health returns status ok
- Response includes version and uptime

**Acceptance Criteria**:

- [ ] All test files created
- [ ] `npm run test:run` passes all tests
- [ ] Session store edge cases covered (empty file, corrupt JSON)
- [ ] SSE format verified with exact string matching
- [ ] Route tests verify status codes and response shapes

---

## Phase 3: Frontend Foundation

### Task 3.1: Set up Vite + React 19 + TypeScript + Tailwind + shadcn scaffold

**Description**: Initialize the frontend build pipeline with Vite, React 19, TypeScript, Tailwind CSS 4, and shadcn/ui configuration.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Phase 2 tasks

**Implementation** - Create `gateway/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': `http://localhost:${process.env.GATEWAY_PORT || 42420}`,
    },
  },
});
```

**Implementation** - Create `gateway/src/client/index.css`:

```css
@import 'tailwindcss';
```

**Implementation** - Create `gateway/src/client/main.tsx`:

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

**Implementation** - Create `gateway/src/client/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DorkOS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

**Implementation** - Create `gateway/components.json` (shadcn config):

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/client/index.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils"
  }
}
```

**Implementation Steps**:

1. Create `vite.config.ts` with React plugin, Tailwind plugin, path aliases, and dev proxy
2. Create `src/client/index.css` with Tailwind import
3. Create `src/client/index.html` with root div and module script
4. Create `src/client/main.tsx` with React 19 createRoot, QueryClientProvider
5. Create `components.json` for shadcn/ui
6. Create `src/client/lib/utils.ts` with shadcn cn() utility
7. Initialize shadcn components: `npx shadcn@latest add button input card badge`
8. Verify `npm run dev:client` starts Vite dev server

**Acceptance Criteria**:

- [ ] Vite dev server starts on port 3000
- [ ] API requests proxied to localhost:42420
- [ ] Tailwind CSS processing works
- [ ] React 19 renders root component
- [ ] Path aliases (@, @shared) resolve correctly
- [ ] shadcn/ui components available
- [ ] TanStack Query provider wraps the app

---

### Task 3.2: Implement API client library and app store

**Description**: Create the typed API client for server communication and Zustand store for client state management.
**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1, Task 1.2

**Implementation** - Create `gateway/src/client/lib/api.ts`:

```typescript
import type { Session, CreateSessionRequest, CommandRegistry } from '@shared/types';

const BASE_URL = '/api';

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Sessions
  createSession: (body: CreateSessionRequest) =>
    fetchJSON<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listSessions: () => fetchJSON<Session[]>('/sessions'),

  getSession: (id: string) => fetchJSON<Session>(`/sessions/${id}`),

  deleteSession: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),

  // Messages (returns EventSource URL for SSE)
  getMessageStreamUrl: (sessionId: string) => `${BASE_URL}/sessions/${sessionId}/messages`,

  // Tool approval
  approveTool: (sessionId: string, toolCallId: string) =>
    fetchJSON<{ ok: boolean }>(`/sessions/${sessionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId }),
    }),

  denyTool: (sessionId: string, toolCallId: string) =>
    fetchJSON<{ ok: boolean }>(`/sessions/${sessionId}/deny`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId }),
    }),

  // Commands
  getCommands: (refresh = false) =>
    fetchJSON<CommandRegistry>(`/commands${refresh ? '?refresh=true' : ''}`),

  // Health
  health: () => fetchJSON<{ status: string; version: string; uptime: number }>('/health'),
};
```

**Implementation** - Create `gateway/src/client/stores/app-store.ts`:

```typescript
import { create } from 'zustand';

interface AppState {
  activeSessionId: string | null;
  sidebarOpen: boolean;

  setActiveSession: (id: string | null) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeSessionId: localStorage.getItem('activeSessionId'),
  sidebarOpen: true,

  setActiveSession: (id) => {
    if (id) {
      localStorage.setItem('activeSessionId', id);
    } else {
      localStorage.removeItem('activeSessionId');
    }
    set({ activeSessionId: id });
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}));
```

**Acceptance Criteria**:

- [ ] API client covers all endpoints: sessions CRUD, messages, approve/deny, commands, health
- [ ] API client handles errors with proper error messages
- [ ] Zustand store manages activeSessionId with localStorage persistence
- [ ] Zustand store manages sidebar open/close state
- [ ] TypeScript types flow from shared types through API client

---

### Task 3.3: Implement base layout components (Header, PermissionBanner, App)

**Description**: Build the Header, PermissionBanner, and root App layout with sidebar + main panel structure.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1

**Implementation** - Create `gateway/src/client/App.tsx`:

```typescript
import { useAppStore } from './stores/app-store';
import { Header } from './components/layout/Header';
import { PermissionBanner } from './components/layout/PermissionBanner';
import { SessionSidebar } from './components/sessions/SessionSidebar';
import { ChatPanel } from './components/chat/ChatPanel';

export function App() {
  const { activeSessionId, sidebarOpen } = useAppStore();

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <PermissionBanner sessionId={activeSessionId} />
      <Header />
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <aside className="w-64 border-r flex-shrink-0 overflow-y-auto">
            <SessionSidebar />
          </aside>
        )}
        <main className="flex-1 overflow-hidden">
          {activeSessionId ? (
            <ChatPanel sessionId={activeSessionId} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Select or create a session to begin
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
```

**Implementation** - Create `gateway/src/client/components/layout/Header.tsx`:

```typescript
import { useAppStore } from '../../stores/app-store';
import { PanelLeft, Plus } from 'lucide-react';

export function Header() {
  const { toggleSidebar } = useAppStore();

  return (
    <header className="flex items-center gap-2 border-b px-4 py-2 h-12">
      <button
        onClick={toggleSidebar}
        className="p-1 rounded hover:bg-accent"
        aria-label="Toggle sidebar"
      >
        <PanelLeft className="h-5 w-5" />
      </button>
      <h1 className="text-sm font-semibold flex-1">DorkOS</h1>
    </header>
  );
}
```

**Implementation** - Create `gateway/src/client/components/layout/PermissionBanner.tsx`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function PermissionBanner({ sessionId }: { sessionId: string | null }) {
  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId!),
    enabled: !!sessionId,
  });

  if (!session || session.permissionMode !== 'dangerously-skip') return null;

  return (
    <div className="bg-red-600 text-white text-center text-sm py-1 px-4">
      Permissions bypassed - all tool calls auto-approved
    </div>
  );
}
```

**Acceptance Criteria**:

- [ ] App renders full-height layout with sidebar + main panel
- [ ] Header shows app title and sidebar toggle
- [ ] PermissionBanner shows red warning only for dangerously-skip sessions
- [ ] Empty state shown when no session is active
- [ ] Sidebar can be toggled open/closed
- [ ] Layout is responsive with proper overflow handling

---

## Phase 4: Chat UI with Streaming

### Task 4.1: Implement useChatSession hook (custom SSE consumer)

**Description**: Build the custom chat session hook that manages SSE streaming, message state, and tool call tracking using native EventSource/fetch.
**Size**: Large
**Priority**: High
**Dependencies**: Task 3.2, Task 2.2

**Implementation** - Create `gateway/src/client/hooks/use-chat-session.ts`:

```typescript
import { useState, useCallback, useRef } from 'react';
import type { StreamEvent, TextDelta, ToolCallEvent, DoneEvent, ErrorEvent } from '@shared/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
  timestamp: string;
}

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: string;
  result?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
}

type ChatStatus = 'idle' | 'streaming' | 'error';

export function useChatSession(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentAssistantRef = useRef<string>('');
  const currentToolCallsRef = useRef<ToolCallState[]>([]);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || status === 'streaming') return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setStatus('streaming');
    setError(null);
    currentAssistantRef.current = '';
    currentToolCallsRef.current = [];

    // Add placeholder assistant message
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        timestamp: new Date().toISOString(),
      },
    ]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMessage.content }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            const data = JSON.parse(line.slice(6));
            handleStreamEvent(eventType, data, assistantId);
            eventType = '';
          }
        }
      }

      setStatus('idle');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
        setStatus('error');
      }
    }
  }, [input, status, sessionId]);

  function handleStreamEvent(type: string, data: unknown, assistantId: string) {
    switch (type) {
      case 'text_delta': {
        const { text } = data as TextDelta;
        currentAssistantRef.current += text;
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_start': {
        const tc = data as ToolCallEvent;
        currentToolCallsRef.current.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: '',
          status: 'running',
        });
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_delta': {
        const tc = data as ToolCallEvent;
        const existing = currentToolCallsRef.current.find((t) => t.toolCallId === tc.toolCallId);
        if (existing && tc.input) {
          existing.input += tc.input;
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_end': {
        const tc = data as ToolCallEvent;
        const existing = currentToolCallsRef.current.find((t) => t.toolCallId === tc.toolCallId);
        if (existing) {
          existing.status = 'complete';
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_result': {
        const tc = data as ToolCallEvent;
        const existing = currentToolCallsRef.current.find((t) => t.toolCallId === tc.toolCallId);
        if (existing) {
          existing.result = tc.result;
          existing.status = 'complete';
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'error': {
        const { message } = data as ErrorEvent;
        setError(message);
        setStatus('error');
        break;
      }
      case 'done': {
        setStatus('idle');
        break;
      }
    }
  }

  function updateAssistantMessage(assistantId: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              content: currentAssistantRef.current,
              toolCalls: [...currentToolCallsRef.current],
            }
          : m
      )
    );
  }

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStatus('idle');
  }, []);

  return { messages, input, setInput, handleSubmit, status, error, stop };
}
```

**Key Details**:

- Uses native fetch + ReadableStream instead of EventSource (POST requests need fetch)
- Parses SSE format manually from response body
- Tracks tool calls in refs for efficient updates
- Updates assistant message in-place as streaming progresses
- Supports abort/cancel via AbortController

**Acceptance Criteria**:

- [ ] Hook manages messages array with user and assistant messages
- [ ] SSE stream parsed correctly from POST response body
- [ ] Text deltas accumulate into assistant message content
- [ ] Tool calls tracked with status transitions (running -> complete)
- [ ] Tool results captured and associated with correct tool call
- [ ] Error events set error state
- [ ] Done event transitions status to idle
- [ ] AbortController stops streaming on cancel
- [ ] Input state managed with setInput

---

### Task 4.2: Implement MessageList with TanStack Virtual

**Description**: Build the virtualized message list with dynamic row heights, auto-scroll to bottom, and overscan.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1

**Implementation** - Create `gateway/src/client/components/chat/MessageList.tsx`:

```typescript
import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '../../hooks/use-chat-session';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80, // Estimated average message height
    overscan: 5,
    // Measure actual heights after render
    measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [messages.length, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <MessageItem message={messages[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Key Details**:

- estimateSize: 80px average per message
- overscan: 5 (renders 5 extra items above/below viewport)
- measureElement callback for dynamic heights
- Auto-scroll on new messages via scrollToIndex with align: 'end'

**Acceptance Criteria**:

- [ ] Renders only visible messages plus 5 overscan items
- [ ] Dynamic heights measured after render
- [ ] Auto-scrolls to bottom when new messages arrive
- [ ] Smooth scrolling through 1000+ messages
- [ ] Proper absolute positioning with transforms

---

### Task 4.3: Implement MessageItem and StreamingText components

**Description**: Build the single message renderer with streaming markdown via Streamdown, and embedded tool call cards.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.2

**Implementation** - Create `gateway/src/client/components/chat/MessageItem.tsx`:

```typescript
import type { ChatMessage } from '../../hooks/use-chat-session';
import { StreamingText } from './StreamingText';
import { ToolCallCard } from './ToolCallCard';
import { User, Bot } from 'lucide-react';

interface MessageItemProps {
  message: ChatMessage;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex gap-3 px-4 py-3 ${isUser ? 'bg-muted/30' : ''}`}>
      <div className="flex-shrink-0 mt-1">
        {isUser ? (
          <div className="rounded-full bg-primary p-1.5">
            <User className="h-4 w-4 text-primary-foreground" />
          </div>
        ) : (
          <div className="rounded-full bg-orange-500 p-1.5">
            <Bot className="h-4 w-4 text-white" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">
          {isUser ? 'You' : 'Claude'}
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <StreamingText content={message.content} />
        </div>
        {message.toolCalls?.map((tc) => (
          <ToolCallCard key={tc.toolCallId} toolCall={tc} />
        ))}
      </div>
    </div>
  );
}
```

**Implementation** - Create `gateway/src/client/components/chat/StreamingText.tsx`:

```typescript
import { useMemo } from 'react';

interface StreamingTextProps {
  content: string;
}

export function StreamingText({ content }: StreamingTextProps) {
  // Use Streamdown for incremental markdown rendering
  // Streamdown provides O(n) incremental parsing with memoized blocks
  const rendered = useMemo(() => {
    // For initial implementation, render as plain text with basic formatting
    // Will be enhanced with Streamdown integration
    return content;
  }, [content]);

  return (
    <div
      className="whitespace-pre-wrap break-words"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}
```

**Note**: The StreamingText component starts with basic rendering and will be enhanced with Streamdown library integration. Streamdown provides O(n) incremental parsing with memoized blocks, ideal for streaming responses.

**Acceptance Criteria**:

- [ ] MessageItem renders user and assistant messages with correct styling
- [ ] User messages have muted background, assistant messages are plain
- [ ] Role icons displayed (User icon for user, Bot icon for assistant)
- [ ] Markdown content rendered via StreamingText
- [ ] Tool calls rendered inline via ToolCallCard components
- [ ] Proper truncation and overflow handling

---

### Task 4.4: Implement ChatInput component

**Description**: Build the chat input textarea with submit handling, Enter key support, and slash command trigger detection.
**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1

**Implementation** - Create `gateway/src/client/components/chat/ChatInput.tsx`:

```typescript
import { useRef, useCallback } from 'react';
import { Send, Square } from 'lucide-react';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  onStop?: () => void;
}

export function ChatInput({ value, onChange, onSubmit, isLoading, onStop }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isLoading && value.trim()) {
          onSubmit();
        }
      }
    },
    [isLoading, value, onSubmit]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      // Auto-resize textarea
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
      }
    },
    [onChange]
  );

  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Type a message or / for commands..."
        className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[40px] max-h-[200px]"
        rows={1}
        disabled={isLoading}
      />
      {isLoading ? (
        <button
          onClick={onStop}
          className="rounded-lg bg-destructive p-2 text-destructive-foreground hover:bg-destructive/90"
          aria-label="Stop generating"
        >
          <Square className="h-4 w-4" />
        </button>
      ) : (
        <button
          onClick={onSubmit}
          disabled={!value.trim()}
          className="rounded-lg bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
```

**Key Details**:

- Enter submits, Shift+Enter for newline
- Auto-resizing textarea up to 200px max height
- Stop button shown during streaming, Send button when idle
- Placeholder mentions "/" for commands
- Disabled during streaming

**Acceptance Criteria**:

- [ ] Enter key submits message (Shift+Enter for newline)
- [ ] Auto-resizing textarea up to 200px
- [ ] Send button disabled when input is empty
- [ ] Stop button shown during loading/streaming
- [ ] Placeholder text: "Type a message or / for commands..."
- [ ] Input disabled during streaming

---

### Task 4.5: Implement ChatPanel (main chat container)

**Description**: Wire together MessageList, ChatInput, CommandPalette trigger, and useChatSession hook into the main chat panel.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.1, Task 4.2, Task 4.3, Task 4.4

**Implementation** - Create `gateway/src/client/components/chat/ChatPanel.tsx`:

```typescript
import { useState } from 'react';
import { useChatSession } from '../../hooks/use-chat-session';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { CommandPalette } from '../commands/CommandPalette';
import type { CommandEntry } from '@shared/types';

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const { messages, input, setInput, handleSubmit, status, error, stop } =
    useChatSession(sessionId);
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');

  function handleInputChange(value: string) {
    setInput(value);
    // Detect slash command trigger
    const match = value.match(/(^|\s)\/(\w*)$/);
    if (match) {
      setShowCommands(true);
      setCommandQuery(match[2]);
    } else {
      setShowCommands(false);
    }
  }

  function handleCommandSelect(cmd: CommandEntry) {
    setInput(cmd.fullCommand + ' ');
    setShowCommands(false);
  }

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} />

      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-destructive/10 text-destructive px-3 py-2 text-sm">
          Error: {error}
        </div>
      )}

      <div className="relative border-t p-4">
        {showCommands && (
          <CommandPalette
            query={commandQuery}
            onSelect={handleCommandSelect}
            onClose={() => setShowCommands(false)}
          />
        )}

        <ChatInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isLoading={status === 'streaming'}
          onStop={stop}
        />
      </div>
    </div>
  );
}
```

**Key Details**:

- Slash command detection via regex `/(^|\s)\/(\w*)$/`
- CommandPalette floats above input when triggered
- Error banner shown below message list
- Stop button wired to abort streaming

**Acceptance Criteria**:

- [ ] Chat panel renders full height with message list and input
- [ ] Messages stream in real-time from SSE connection
- [ ] Typing `/` triggers command palette
- [ ] Command selection inserts command into input
- [ ] Error messages shown in destructive banner
- [ ] Stop button cancels active streaming
- [ ] All components properly wired together

---

## Phase 5: Tool Calls & Permissions

### Task 5.1: Implement ToolCallCard component

**Description**: Build the inline tool call display with expand/collapse, status icons, and input/result rendering.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.3

**Implementation** - Create `gateway/src/client/components/chat/ToolCallCard.tsx`:

```typescript
import { useState } from 'react';
import { Loader2, Check, X, ChevronDown } from 'lucide-react';
import type { ToolCallState } from '../../hooks/use-chat-session';

interface ToolCallCardProps {
  toolCall: ToolCallState;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    pending: <Loader2 className="h-3 w-3 animate-spin" />,
    running: <Loader2 className="h-3 w-3 animate-spin text-blue-500" />,
    complete: <Check className="h-3 w-3 text-green-500" />,
    error: <X className="h-3 w-3 text-red-500" />,
  }[toolCall.status];

  return (
    <div className="my-1 rounded border bg-muted/50 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5"
      >
        {statusIcon}
        <span className="font-mono">{toolCall.toolName}</span>
        <ChevronDown
          className={`ml-auto h-3 w-3 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <div className="border-t px-3 py-2">
          {toolCall.input && (
            <pre className="text-xs overflow-x-auto whitespace-pre-wrap">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(toolCall.input), null, 2);
                } catch {
                  return toolCall.input;
                }
              })()}
            </pre>
          )}
          {toolCall.result && (
            <pre className="mt-2 text-xs overflow-x-auto border-t pt-2 whitespace-pre-wrap">
              {toolCall.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
```

**Key Details**:

- Status icons: spinning loader (pending/running), green check (complete), red X (error)
- Running status uses blue color for spinner
- Expand/collapse with chevron rotation animation
- Input shown as pretty-printed JSON (with fallback for non-JSON)
- Result shown below input with border separator

**Acceptance Criteria**:

- [ ] Tool call card shows tool name and status icon
- [ ] Click toggles expand/collapse
- [ ] Expanded view shows pretty-printed input JSON
- [ ] Expanded view shows result below input
- [ ] Status icons match: pending=spinner, running=blue spinner, complete=green check, error=red X
- [ ] Chevron rotates on expand

---

### Task 5.2: Implement ToolApproval component and approval flow

**Description**: Build the inline approve/deny buttons for tool calls requiring approval, and wire them to the approval API endpoints.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 5.1, Task 2.2

**Implementation** - Create `gateway/src/client/components/chat/ToolApproval.tsx`:

```typescript
import { useState } from 'react';
import { Check, X, Shield } from 'lucide-react';
import { api } from '../../lib/api';

interface ToolApprovalProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
}

export function ToolApproval({ sessionId, toolCallId, toolName, input }: ToolApprovalProps) {
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);

  async function handleApprove() {
    setResponding(true);
    try {
      await api.approveTool(sessionId, toolCallId);
      setDecided('approved');
    } catch (err) {
      console.error('Approval failed:', err);
    } finally {
      setResponding(false);
    }
  }

  async function handleDeny() {
    setResponding(true);
    try {
      await api.denyTool(sessionId, toolCallId);
      setDecided('denied');
    } catch (err) {
      console.error('Deny failed:', err);
    } finally {
      setResponding(false);
    }
  }

  if (decided) {
    return (
      <div className={`my-1 rounded border px-3 py-2 text-sm ${
        decided === 'approved' ? 'border-green-500/50 bg-green-500/10' : 'border-red-500/50 bg-red-500/10'
      }`}>
        <span className="font-mono">{toolName}</span>
        <span className="ml-2 text-xs">
          {decided === 'approved' ? 'Approved' : 'Denied'}
        </span>
      </div>
    );
  }

  return (
    <div className="my-1 rounded border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm">
      <div className="flex items-center gap-2 mb-2">
        <Shield className="h-4 w-4 text-yellow-500" />
        <span className="font-semibold">Tool approval required</span>
      </div>
      <div className="font-mono text-xs mb-2">{toolName}</div>
      {input && (
        <pre className="text-xs overflow-x-auto mb-3 p-2 bg-muted rounded whitespace-pre-wrap">
          {(() => {
            try {
              return JSON.stringify(JSON.parse(input), null, 2);
            } catch {
              return input;
            }
          })()}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-white text-xs hover:bg-green-700 disabled:opacity-50"
        >
          <Check className="h-3 w-3" /> Approve
        </button>
        <button
          onClick={handleDeny}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-white text-xs hover:bg-red-700 disabled:opacity-50"
        >
          <X className="h-3 w-3" /> Deny
        </button>
      </div>
    </div>
  );
}
```

**Acceptance Criteria**:

- [ ] Approval card shows tool name, input preview, and approve/deny buttons
- [ ] Approve button calls POST /api/sessions/:id/approve
- [ ] Deny button calls POST /api/sessions/:id/deny
- [ ] Buttons disabled while request in progress
- [ ] After decision, card shows approved/denied state with color coding
- [ ] Shield icon and "Tool approval required" header
- [ ] Input shown as pretty-printed JSON

---

### Task 5.3: Implement permission mode selection and banner integration

**Description**: Add permission mode toggle to session creation dialog and ensure PermissionBanner displays correctly.
**Size**: Small
**Priority**: High
**Dependencies**: Task 3.3, Task 5.2

**Implementation Details**:

Update the session creation flow (in SessionSidebar or a CreateSessionDialog) to include a permission mode toggle:

```typescript
// In session creation dialog/form
const [permissionMode, setPermissionMode] = useState<'default' | 'dangerously-skip'>('default');

// Toggle UI
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={permissionMode === 'dangerously-skip'}
    onChange={(e) =>
      setPermissionMode(e.target.checked ? 'dangerously-skip' : 'default')
    }
  />
  <span className="text-red-500 font-medium">Skip permissions</span>
</label>

{permissionMode === 'dangerously-skip' && (
  <p className="text-xs text-red-500 mt-1">
    All tool calls will be auto-approved. Cannot be changed after session creation.
  </p>
)}
```

**Key Details**:

- Permission mode is set at session creation and cannot be changed mid-session
- Red warning text when skip-permissions is selected
- PermissionBanner (from Task 3.3) shows persistent red bar at top when active
- Banner text: "Permissions bypassed - all tool calls auto-approved"

**Acceptance Criteria**:

- [ ] Session creation includes permission mode toggle
- [ ] Default mode is 'default' (permissions required)
- [ ] Warning text shown when skip-permissions selected
- [ ] Permission mode stored in session and cannot be changed after creation
- [ ] PermissionBanner appears at top of screen for dangerously-skip sessions
- [ ] Banner is persistent red with white text

---

## Phase 6: Slash Commands

### Task 6.1: Implement command registry service (`src/server/services/command-registry.ts`)

**Description**: Build the server-side service that scans `.claude/commands/` recursively, parses YAML frontmatter, and caches results.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.1

**Implementation** - Create `gateway/src/server/services/command-registry.ts`:

```typescript
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import type { CommandEntry, CommandRegistry } from '../../shared/types';

class CommandRegistryService {
  private cache: CommandRegistry | null = null;
  private readonly commandsDir: string;

  constructor(vaultRoot: string) {
    this.commandsDir = path.join(vaultRoot, '.claude', 'commands');
  }

  async getCommands(forceRefresh = false): Promise<CommandRegistry> {
    if (this.cache && !forceRefresh) return this.cache;

    const commands: CommandEntry[] = [];
    const namespaces = await fs.readdir(this.commandsDir, {
      withFileTypes: true,
    });

    for (const ns of namespaces) {
      if (!ns.isDirectory()) continue;

      const nsPath = path.join(this.commandsDir, ns.name);
      const files = await fs.readdir(nsPath);

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(nsPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const { data: frontmatter } = matter(content);

        const commandName = file.replace('.md', '');
        commands.push({
          namespace: ns.name,
          command: commandName,
          fullCommand: `/${ns.name}:${commandName}`,
          description: frontmatter.description || '',
          argumentHint: frontmatter['argument-hint'],
          allowedTools: frontmatter['allowed-tools']?.split(',').map((t: string) => t.trim()),
          filePath: path.relative(process.cwd(), filePath),
        });
      }
    }

    // Sort by namespace, then command name
    commands.sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));

    this.cache = { commands, lastScanned: new Date().toISOString() };
    return this.cache;
  }

  invalidateCache(): void {
    this.cache = null;
  }
}

export { CommandRegistryService };
```

**Unit Tests**:

- Scanning discovers all command files in namespace directories
- YAML frontmatter parsed correctly (description, argument-hint, allowed-tools)
- Non-.md files ignored
- Non-directory entries in commands/ ignored
- Commands sorted by fullCommand
- Cache returns same result on second call
- forceRefresh=true rescans filesystem
- invalidateCache forces rescan on next call

**Acceptance Criteria**:

- [ ] Scans `.claude/commands/<namespace>/<command>.md` recursively
- [ ] Parses YAML frontmatter for description, argument-hint, allowed-tools
- [ ] Returns sorted CommandRegistry with lastScanned timestamp
- [ ] Caching: returns cached result unless forceRefresh=true
- [ ] invalidateCache() clears the cache
- [ ] Non-.md files and non-directory entries ignored
- [ ] All unit tests pass

---

### Task 6.2: Implement commands route (`src/server/routes/commands.ts`)

**Description**: Build the GET /api/commands endpoint with refresh support.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 6.1, Task 1.6

**Implementation** - Create `gateway/src/server/routes/commands.ts`:

```typescript
import { Router } from 'express';
import { CommandRegistryService } from '../services/command-registry';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(__dirname, '../../../../');
const registry = new CommandRegistryService(vaultRoot);
const router = Router();

// GET /api/commands - List all commands (with optional refresh)
router.get('/', async (req, res) => {
  const refresh = req.query.refresh === 'true';
  const commands = await registry.getCommands(refresh);
  res.json(commands);
});

export default router;
```

**Acceptance Criteria**:

- [ ] GET /api/commands returns CommandRegistry JSON
- [ ] GET /api/commands?refresh=true forces cache refresh
- [ ] Response includes commands array and lastScanned timestamp
- [ ] Commands include all expected fields (namespace, command, fullCommand, description, etc.)

---

### Task 6.3: Implement useCommands hook

**Description**: Build the TanStack Query-based hook for fetching and caching the command registry on the client.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.2, Task 6.2

**Implementation** - Create `gateway/src/client/hooks/use-commands.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { CommandRegistry } from '@shared/types';

export function useCommands() {
  return useQuery<CommandRegistry>({
    queryKey: ['commands'],
    queryFn: () => api.getCommands(),
    staleTime: 5 * 60 * 1000, // 5 minutes - commands don't change often
    gcTime: 30 * 60 * 1000, // 30 minutes garbage collection
  });
}

export function useRefreshCommands() {
  return useQuery<CommandRegistry>({
    queryKey: ['commands', 'refresh'],
    queryFn: () => api.getCommands(true),
    enabled: false, // Only run when manually triggered
  });
}
```

**Acceptance Criteria**:

- [ ] useCommands returns TanStack Query result with data, isLoading, error
- [ ] Commands cached for 5 minutes (staleTime)
- [ ] Garbage collected after 30 minutes
- [ ] useRefreshCommands available for manual refresh

---

### Task 6.4: Implement CommandPalette component

**Description**: Build the cmdk-based floating command dropdown with namespace grouping, filtering, and keyboard navigation.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 6.3

**Implementation** - Create `gateway/src/client/components/commands/CommandPalette.tsx`:

```typescript
import { Command } from 'cmdk';
import { useCommands } from '../../hooks/use-commands';
import type { CommandEntry } from '@shared/types';

interface CommandPaletteProps {
  query: string;
  onSelect: (cmd: CommandEntry) => void;
  onClose: () => void;
}

export function CommandPalette({ query, onSelect, onClose }: CommandPaletteProps) {
  const { data: registry } = useCommands();
  const commands = registry?.commands ?? [];

  // Group by namespace
  const grouped = commands.reduce<Record<string, CommandEntry[]>>(
    (acc, cmd) => {
      (acc[cmd.namespace] ??= []).push(cmd);
      return acc;
    },
    {}
  );

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-hidden rounded-lg border bg-popover shadow-lg">
      <Command shouldFilter={true}>
        <Command.Input
          value={query}
          className="sr-only"
          autoFocus={false}
        />
        <Command.List className="max-h-72 overflow-y-auto p-2">
          <Command.Empty>No commands found.</Command.Empty>
          {Object.entries(grouped).map(([namespace, cmds]) => (
            <Command.Group key={namespace} heading={namespace}>
              {cmds.map((cmd) => (
                <Command.Item
                  key={cmd.fullCommand}
                  value={`${cmd.fullCommand} ${cmd.description}`}
                  onSelect={() => onSelect(cmd)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer data-[selected=true]:bg-accent"
                >
                  <span className="font-mono text-sm">
                    {cmd.fullCommand}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {cmd.description}
                  </span>
                  {cmd.argumentHint && (
                    <span className="text-xs text-muted-foreground/60 ml-auto">
                      {cmd.argumentHint}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
```

**Key Details**:

- Uses cmdk library for built-in filtering and keyboard navigation
- Commands grouped by namespace with headings
- Value includes fullCommand + description for search matching
- Argument hint shown on the right side
- Max height 80/320px with scrolling
- Positioned above the input (bottom-full)

**Acceptance Criteria**:

- [ ] Floating dropdown positioned above chat input
- [ ] Commands grouped by namespace
- [ ] Filtering works as user types after "/"
- [ ] Keyboard navigation (arrow keys, Enter to select)
- [ ] Selected command triggers onSelect callback
- [ ] Empty state: "No commands found."
- [ ] Argument hints displayed where available
- [ ] Max height with scroll for long command lists

---

### Task 6.5: Integrate slash command detection into ChatInput

**Description**: Wire the CommandPalette into the ChatPanel by enhancing the slash command detection logic and ensuring proper command insertion.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 6.4, Task 4.4

**Implementation Details**:

This task ensures the slash command detection in ChatPanel (Task 4.5) works end-to-end:

1. The regex `/(^|\s)\/(\w*)$/` in ChatPanel.handleInputChange detects when user types `/`
2. CommandPalette opens and filters based on what follows the `/`
3. When a command is selected, it replaces the `/query` with the full command
4. Escape key closes the palette
5. Clicking outside closes the palette

**Enhanced ChatInput integration**:

```typescript
// In ChatInput, add Escape key handler
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onEscape?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading && value.trim()) {
        onSubmit();
      }
    }
  },
  [isLoading, value, onSubmit, onEscape]
);
```

**Acceptance Criteria**:

- [ ] Typing "/" at start of input or after space triggers command palette
- [ ] Continued typing after "/" filters commands
- [ ] Selecting a command inserts it into the input
- [ ] Escape key closes the command palette
- [ ] Enter on a selected command inserts it (does not submit)
- [ ] Palette closes after command selection
- [ ] Palette closes when input no longer matches slash pattern

---

## Phase 7: Session Management & Polish

### Task 7.1: Implement SessionSidebar and SessionItem components

**Description**: Build the session list sidebar with create button, session list with previews, and delete capability.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.3, Task 2.2

**Implementation** - Create `gateway/src/client/components/sessions/SessionSidebar.tsx`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/app-store';
import { SessionItem } from './SessionItem';
import { Plus } from 'lucide-react';
import type { Session } from '@shared/types';

export function SessionSidebar() {
  const queryClient = useQueryClient();
  const { activeSessionId, setActiveSession } = useAppStore();

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
  });

  const createMutation = useMutation({
    mutationFn: api.createSession,
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setActiveSession(session.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteSession,
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (activeSessionId === deletedId) {
        setActiveSession(null);
      }
    },
  });

  return (
    <div className="flex flex-col h-full p-2">
      <button
        onClick={() => createMutation.mutate({})}
        className="flex items-center gap-2 w-full rounded-lg border border-dashed p-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground mb-2"
      >
        <Plus className="h-4 w-4" />
        New Session
      </button>

      <div className="flex-1 overflow-y-auto space-y-1">
        {sessions.map((session: Session) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onClick={() => setActiveSession(session.id)}
            onDelete={() => deleteMutation.mutate(session.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

**Implementation** - Create `gateway/src/client/components/sessions/SessionItem.tsx`:

```typescript
import { Trash2 } from 'lucide-react';
import type { Session } from '@shared/types';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onClick, onDelete }: SessionItemProps) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer ${
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{session.title}</div>
        {session.lastMessagePreview && (
          <div className="text-xs text-muted-foreground truncate">
            {session.lastMessagePreview}
          </div>
        )}
      </div>
      {session.permissionMode === 'dangerously-skip' && (
        <span className="text-xs text-red-500 flex-shrink-0">!</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/20"
        aria-label="Delete session"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
```

**Acceptance Criteria**:

- [ ] New Session button creates a session and sets it active
- [ ] Session list shows all sessions sorted by updatedAt
- [ ] Active session highlighted with accent color
- [ ] Session title and message preview truncated with ellipsis
- [ ] Delete button appears on hover
- [ ] Delete removes session and clears active if deleted
- [ ] Danger indicator (!) shown for skip-permissions sessions
- [ ] Clicking a session makes it active

---

### Task 7.2: Implement useSessions hook and session lifecycle

**Description**: Build the hook managing session CRUD operations, active session persistence in localStorage, and auto-title generation from first message.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.2, Task 7.1

**Implementation** - Create `gateway/src/client/hooks/use-sessions.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAppStore } from '../stores/app-store';
import type { CreateSessionRequest } from '@shared/types';

export function useSessions() {
  const queryClient = useQueryClient();
  const { activeSessionId, setActiveSession } = useAppStore();

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });

  const createSession = useMutation({
    mutationFn: (opts: CreateSessionRequest) => api.createSession(opts),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setActiveSession(session.id);
    },
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (activeSessionId === deletedId) {
        // Switch to most recent remaining session
        const remaining = sessionsQuery.data?.filter((s) => s.id !== deletedId);
        setActiveSession(remaining?.[0]?.id ?? null);
      }
    },
  });

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    createSession,
    deleteSession,
    activeSessionId,
    setActiveSession,
  };
}
```

**Key Details**:

- Sessions refresh every 30 seconds
- Active session persisted in localStorage via Zustand store
- On delete, switches to most recent remaining session
- Create mutation auto-switches to new session

**Acceptance Criteria**:

- [ ] Sessions list refreshes every 30 seconds
- [ ] Active session ID persisted in localStorage
- [ ] Creating a session auto-switches to it
- [ ] Deleting active session switches to next most recent
- [ ] All CRUD operations invalidate sessions query cache

---

### Task 7.3: Implement session memory management

**Description**: Add periodic session health checks that clean up stale sessions from the agent manager to prevent memory leaks.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.1, Task 7.2

**Implementation Details**:

Add a periodic health check interval to the server startup in `src/server/index.ts`:

```typescript
// In the start() function, after app.listen():
// Run session health check every 5 minutes
setInterval(
  () => {
    agentManager.checkSessionHealth();
  },
  5 * 60 * 1000
);
```

The `checkSessionHealth()` method already exists in AgentManager (Task 2.1). This task wires it into the server lifecycle.

**Key Details**:

- Health check runs every 5 minutes
- Sessions inactive for 30+ minutes are cleaned up
- Cleaned sessions can be resumed via SDK resume on next message
- This prevents the known 400MB -> 4GB memory leak issue

**Acceptance Criteria**:

- [ ] Health check interval runs every 5 minutes
- [ ] Stale sessions (30+ min inactive) removed from memory
- [ ] Removed sessions can still be resumed via SDK resume
- [ ] No memory leak over extended server uptime

---

### Task 7.4: Write frontend component tests

**Description**: Test MessageList virtualization, CommandPalette filtering, ToolCallCard rendering, ChatInput behavior, and PermissionBanner visibility.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 4.5, Task 5.3, Task 6.5, Task 7.2

**Test Files to Create**:

1. `gateway/src/client/components/chat/__tests__/MessageList.test.tsx`
2. `gateway/src/client/components/chat/__tests__/ChatInput.test.tsx`
3. `gateway/src/client/components/chat/__tests__/ToolCallCard.test.tsx`
4. `gateway/src/client/components/commands/__tests__/CommandPalette.test.tsx`
5. `gateway/src/client/components/layout/__tests__/PermissionBanner.test.tsx`

**MessageList Tests**:

- Renders correct number of visible items (not all messages)
- Auto-scrolls to bottom on new messages
- Handles empty message list

**ChatInput Tests**:

- Enter key submits (not Shift+Enter)
- Disabled during loading
- Auto-resize on multiline input
- Send button disabled when empty

**ToolCallCard Tests**:

- Shows correct status icon for each status
- Expand/collapse toggles content visibility
- Pretty-prints JSON input
- Shows result section when result exists

**CommandPalette Tests**:

- Filters commands by query text
- Groups commands by namespace
- Selection triggers callback
- Empty state shown when no matches

**PermissionBanner Tests**:

- Returns null for default permission mode
- Shows red banner for dangerously-skip mode
- Correct banner text

**Acceptance Criteria**:

- [ ] All test files created
- [ ] `npm run test:run` passes all frontend tests
- [ ] Component rendering verified with React Testing Library
- [ ] User interaction tested (clicks, keyboard events)
- [ ] Conditional rendering verified (banner show/hide, card expand/collapse)

---

### Task 7.5: Create gateway README and update system documentation

**Description**: Write `gateway/README.md` with setup, development, and production instructions. Update `workspace/0-System/README.md` and `.claude/rules/components.md` to reference the gateway.
**Size**: Small
**Priority**: Low
**Dependencies**: Task 7.4

**Implementation** - Create `gateway/README.md`:

Contents should include:

- Overview: What the gateway is and its purpose
- Prerequisites: Node.js 20+, npm
- Quick Start: `cd gateway && npm install && npm run dev`
- Development: Server (port 42420) + Vite dev server (port 3000)
- Production: `npm run build && npm start`
- API Reference: Table of all endpoints
- Architecture: Brief overview of src/ structure
- Environment Variables: GATEWAY_PORT

**Documentation Updates**:

- Update `workspace/0-System/README.md`: Change gateway reference from "Node.js API server (future)" to "Node.js API server - WebUI & channel-agnostic API"
- Update `.claude/rules/components.md`: Add gateway section with routes, services, and components

**Acceptance Criteria**:

- [ ] `gateway/README.md` exists with setup and usage instructions
- [ ] All API endpoints documented
- [ ] Development and production workflows described
- [ ] System README updated to reference gateway as implemented
- [ ] Components.md updated with gateway components

---

## Summary

| Phase                        | Tasks     | Description                                                                         |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------- |
| Phase 1: Server Foundation   | 1.1 - 1.6 | Project setup, shared types, session store, SSE adapter, health route, server entry |
| Phase 2: SDK Integration     | 2.1 - 2.3 | Agent manager, sessions route, server tests                                         |
| Phase 3: Frontend Foundation | 3.1 - 3.3 | Vite/React scaffold, API client, base layout                                        |
| Phase 4: Chat UI             | 4.1 - 4.5 | Chat hook, message list, message item, chat input, chat panel                       |
| Phase 5: Tool Calls          | 5.1 - 5.3 | Tool call card, approval flow, permission mode                                      |
| Phase 6: Slash Commands      | 6.1 - 6.5 | Command registry, commands route, useCommands, palette, integration                 |
| Phase 7: Session Management  | 7.1 - 7.5 | Session sidebar, useSessions, memory management, tests, docs                        |

**Total Tasks**: 25
