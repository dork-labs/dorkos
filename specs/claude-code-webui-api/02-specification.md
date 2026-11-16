---
slug: claude-code-webui-api
status: Draft
---

# Claude Code WebUI & Reusable API v1

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-02-06
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Build a web-based interface for Claude Code that mirrors the CLI experience, backed by a channel-agnostic REST/SSE API. The WebUI provides chat with streaming responses, inline tool call visualization, slash command auto-complete, session continuity, and per-session permission control. The API is designed for reuse by other channels (Slack bots, mobile clients, custom integrations).

All code lives in `gateway/` as a single TypeScript package with `src/server/`, `src/client/`, and `src/shared/` directories.

---

## 2. Background / Problem Statement

The Claude Code CLI is powerful but terminal-bound. Users who prefer a graphical interface, want to share sessions visually, or need richer tool call visualization have no alternative. Additionally, there is no programmatic API to drive Claude Code from external services (Slack, mobile, CI/CD).

The `gateway/` directory was reserved in the DorkOS architecture specifically for this purpose (documented as "Node.js API server (future)" in `workspace/0-System/README.md`).

---

## 3. Goals

- Provide a browser-based chat UI with feature parity to the core CLI experience
- Stream Claude Code responses in real-time with markdown rendering
- Display tool calls inline with name, parameters, status, and results
- Enable slash command discovery and auto-complete from `.claude/commands/`
- Support session creation, listing, resumption, and deletion
- Expose a channel-agnostic API that other clients can consume
- Support `--dangerously-skip-permissions` mode with explicit per-session opt-in
- Handle tool call approval inline when permissions are not skipped
- Virtualize long message histories for smooth performance

---

## 4. Non-Goals

- Multi-user authentication and authorization (single-user, localhost)
- Cloud deployment or hosting infrastructure
- Mobile-native UI (API supports it, but no mobile app)
- Replacing the CLI (WebUI is an additional interface)
- MCP server management UI
- File tree browser or vault search (v2)
- Agent status tracking panel (v2)
- Hook debugging panel (v2)
- Dark/light theme sync with vault theme (v2)
- Split-pane code editor (v2)

---

## 5. Technical Dependencies

### Backend

| Package                          | Version | Purpose                                   |
| -------------------------------- | ------- | ----------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | latest  | Core SDK - embeds Claude Code agent loop  |
| `express`                        | ^4.21   | HTTP server framework                     |
| `cors`                           | ^2.8    | CORS middleware                           |
| `dotenv`                         | ^16.4   | Environment variable loading              |
| `gray-matter`                    | ^4.0    | Parse YAML frontmatter from command files |
| `uuid`                           | ^10.0   | Generate session IDs                      |
| `tsx`                            | ^4.19   | TypeScript execution for development      |

### Frontend

| Package                   | Version | Purpose                                 |
| ------------------------- | ------- | --------------------------------------- |
| `react`                   | ^19.0   | UI framework                            |
| `react-dom`               | ^19.0   | React DOM rendering                     |
| `@ai-sdk/react`           | latest  | `useChat` hook for streaming chat state |
| `ai`                      | latest  | Vercel AI SDK core                      |
| `@tanstack/react-virtual` | ^3.11   | Message list virtualization             |
| `@tanstack/react-query`   | ^5.62   | Server state management                 |
| `zustand`                 | ^5.0    | Client state management                 |
| `cmdk`                    | ^1.0    | Command palette for slash commands      |
| `streamdown`              | latest  | Streaming markdown renderer             |
| `tailwindcss`             | ^4.0    | Utility-first CSS                       |
| `@shadcn/ui`              | latest  | UI component library                    |
| `lucide-react`            | latest  | Icons                                   |

### Dev Dependencies

| Package                  | Version | Purpose                   |
| ------------------------ | ------- | ------------------------- |
| `vite`                   | ^6.0    | Build tool and dev server |
| `@vitejs/plugin-react`   | latest  | React plugin for Vite     |
| `typescript`             | ^5.7    | Type checking             |
| `@types/react`           | ^19.0   | React type definitions    |
| `@types/express`         | ^5.0    | Express type definitions  |
| `vitest`                 | ^2.1    | Testing framework         |
| `@testing-library/react` | ^16.0   | React component testing   |

---

## 6. Detailed Design

### 6.1 Architecture Overview

```
gateway/
├── src/
│   ├── server/                    # Express API server
│   │   ├── index.ts               # Server entry point
│   │   ├── routes/
│   │   │   ├── sessions.ts        # Session CRUD + message streaming
│   │   │   ├── commands.ts        # Command registry API
│   │   │   └── health.ts          # Health check
│   │   ├── services/
│   │   │   ├── agent-manager.ts   # SDK session lifecycle
│   │   │   ├── command-registry.ts # Scan & parse .claude/commands/
│   │   │   ├── session-store.ts   # Lightweight JSON session registry
│   │   │   └── stream-adapter.ts  # SDK stream → SSE adapter
│   │   ├── middleware/
│   │   │   └── error-handler.ts   # Global error handling
│   │   └── types.ts               # Server-specific types
│   │
│   ├── client/                    # React 19 frontend
│   │   ├── main.tsx               # Entry point
│   │   ├── App.tsx                # Root layout
│   │   ├── components/
│   │   │   ├── chat/
│   │   │   │   ├── ChatPanel.tsx       # Main chat container
│   │   │   │   ├── MessageList.tsx     # Virtualized message list
│   │   │   │   ├── MessageItem.tsx     # Single message renderer
│   │   │   │   ├── ChatInput.tsx       # Input with slash command trigger
│   │   │   │   ├── ToolCallCard.tsx    # Inline tool call display
│   │   │   │   ├── ToolApproval.tsx    # Approve/deny buttons
│   │   │   │   └── StreamingText.tsx   # Streaming markdown renderer
│   │   │   ├── commands/
│   │   │   │   └── CommandPalette.tsx  # cmdk-based slash command dropdown
│   │   │   ├── sessions/
│   │   │   │   ├── SessionSidebar.tsx  # Session list + create/delete
│   │   │   │   └── SessionItem.tsx     # Single session row
│   │   │   ├── layout/
│   │   │   │   ├── Header.tsx          # Top bar with session title + permission badge
│   │   │   │   └── PermissionBanner.tsx # Red warning banner
│   │   │   └── ui/                # shadcn components (generated)
│   │   ├── hooks/
│   │   │   ├── use-chat-session.ts    # Wraps useChat with session logic
│   │   │   ├── use-commands.ts        # Fetch + cache command registry
│   │   │   └── use-sessions.ts        # Session CRUD operations
│   │   ├── stores/
│   │   │   └── app-store.ts           # Zustand: UI state, active session
│   │   ├── lib/
│   │   │   ├── api.ts                 # Typed API client
│   │   │   └── utils.ts              # Utility functions
│   │   └── index.css                  # Tailwind entry
│   │
│   └── shared/                    # Shared between server and client
│       └── types.ts               # API contracts, message types
│
├── public/                        # Static assets
├── package.json
├── tsconfig.json
├── tsconfig.server.json           # Server TypeScript config
├── vite.config.ts
├── tailwind.config.ts
├── components.json                # shadcn configuration
└── .env                           # GATEWAY_PORT=42420
```

### 6.2 Shared Types (`src/shared/types.ts`)

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

### 6.3 Server: Agent Manager (`src/server/services/agent-manager.ts`)

The agent manager wraps the Claude Agent SDK, handling session creation, message streaming, and memory management.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Session, StreamEvent } from '../../shared/types';

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

    const vaultRoot = process.cwd(); // gateway/ is in the vault root
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

  // Memory management: check and restart stale sessions
  async checkSessionHealth(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        // Session will auto-resume on next message via SDK resume
        this.sessions.delete(id);
      }
    }
  }
}

export const agentManager = new AgentManager();
```

### 6.4 Server: Command Registry (`src/server/services/command-registry.ts`)

Scans `.claude/commands/` recursively, parses YAML frontmatter, and returns structured command metadata.

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
```

### 6.5 Server: Session Store (`src/server/services/session-store.ts`)

Lightweight JSON file that persists session metadata. Actual conversation data lives in the SDK's built-in storage (`$HOME/.claude`).

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

### 6.6 Server: SSE Stream Adapter (`src/server/services/stream-adapter.ts`)

Translates the `AgentManager` async generator into SSE format for HTTP responses.

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

### 6.7 Server: Routes

**Sessions Route (`src/server/routes/sessions.ts`):**

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
  // Handled via agentManager.approveTool(sessionId, toolCallId, true)
  res.json({ ok: true });
});

// POST /api/sessions/:id/deny - Deny pending tool call
router.post('/:id/deny', async (req, res) => {
  // Handled via agentManager.approveTool(sessionId, toolCallId, false)
  res.json({ ok: true });
});

export default router;
```

**Commands Route (`src/server/routes/commands.ts`):**

```typescript
import { Router } from 'express';
import { CommandRegistryService } from '../services/command-registry';

const registry = new CommandRegistryService(process.cwd());
const router = Router();

// GET /api/commands - List all commands
router.get('/', async (_req, res) => {
  const commands = await registry.getCommands();
  res.json(commands);
});

// GET /api/commands?refresh=true - Force refresh
router.get('/', async (req, res) => {
  const refresh = req.query.refresh === 'true';
  const commands = await registry.getCommands(refresh);
  res.json(commands);
});

export default router;
```

**Health Route (`src/server/routes/health.ts`):**

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

### 6.8 Server Entry Point (`src/server/index.ts`)

```typescript
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import sessionRoutes from './routes/sessions';
import commandRoutes from './routes/commands';
import healthRoutes from './routes/health';
import { sessionStore } from './services/session-store';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const PORT = parseInt(process.env.GATEWAY_PORT || '42420', 10);
const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/sessions', sessionRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/health', healthRoutes);

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
  app.listen(PORT, () => {
    console.log(`Gateway server running on http://localhost:${PORT}`);
  });
}

start();
```

### 6.9 Frontend: Chat Panel (`src/client/components/chat/ChatPanel.tsx`)

The main chat component integrating `useChat`, virtualization, and slash commands.

```typescript
// Simplified component structure (not full implementation)

function ChatPanel({ sessionId }: { sessionId: string }) {
  const { messages, input, setInput, handleSubmit, status } =
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

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} />

      <div className="relative border-t p-4">
        {showCommands && (
          <CommandPalette
            query={commandQuery}
            onSelect={(cmd) => {
              setInput(cmd.fullCommand + ' ');
              setShowCommands(false);
            }}
            onClose={() => setShowCommands(false)}
          />
        )}

        <ChatInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isLoading={status === 'streaming'}
        />
      </div>
    </div>
  );
}
```

### 6.10 Frontend: Virtualized Message List

Uses TanStack Virtual with dynamic row heights for smooth scrolling through long conversations.

```typescript
function MessageList({ messages }: { messages: Message[] }) {
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
  }, [messages.length]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
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

### 6.11 Frontend: Command Palette

```typescript
import { Command } from 'cmdk';
import { useCommands } from '../../hooks/use-commands';

function CommandPalette({
  query,
  onSelect,
  onClose,
}: {
  query: string;
  onSelect: (cmd: CommandEntry) => void;
  onClose: () => void;
}) {
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

### 6.12 Frontend: Tool Call Card

```typescript
function ToolCallCard({ toolCall }: { toolCall: ToolCallEvent }) {
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
          className={cn(
            'ml-auto h-3 w-3 transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded && (
        <div className="border-t px-3 py-2">
          {toolCall.input && (
            <pre className="text-xs overflow-x-auto">
              {JSON.stringify(JSON.parse(toolCall.input), null, 2)}
            </pre>
          )}
          {toolCall.result && (
            <pre className="mt-2 text-xs overflow-x-auto border-t pt-2">
              {toolCall.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
```

### 6.13 Frontend: Permission Banner

```typescript
function PermissionBanner({ mode }: { mode: 'default' | 'dangerously-skip' }) {
  if (mode !== 'dangerously-skip') return null;

  return (
    <div className="bg-red-600 text-white text-center text-sm py-1 px-4">
      Permissions bypassed - all tool calls auto-approved
    </div>
  );
}
```

### 6.14 Vite Configuration

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
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

---

## 7. API Reference

| Method   | Endpoint                     | Description         | Response                      |
| -------- | ---------------------------- | ------------------- | ----------------------------- |
| `POST`   | `/api/sessions`              | Create new session  | `Session` JSON                |
| `GET`    | `/api/sessions`              | List all sessions   | `Session[]` JSON              |
| `GET`    | `/api/sessions/:id`          | Get session details | `Session` JSON                |
| `DELETE` | `/api/sessions/:id`          | Delete session      | `{ ok: true }`                |
| `POST`   | `/api/sessions/:id/messages` | Send message        | SSE stream of `StreamEvent`   |
| `POST`   | `/api/sessions/:id/approve`  | Approve tool call   | `{ ok: true }`                |
| `POST`   | `/api/sessions/:id/deny`     | Deny tool call      | `{ ok: true }`                |
| `GET`    | `/api/commands`              | List slash commands | `CommandRegistry` JSON        |
| `GET`    | `/api/health`                | Health check        | `{ status, version, uptime }` |

### SSE Stream Event Format

Each SSE message has an `event` field (the type) and a `data` field (JSON payload):

```
event: text_delta
data: {"text":"Hello, "}

event: text_delta
data: {"text":"how can "}

event: tool_call_start
data: {"toolCallId":"tc_1","toolName":"Read","status":"running"}

event: tool_result
data: {"toolCallId":"tc_1","toolName":"Read","result":"file contents...","status":"complete"}

event: done
data: {"sessionId":"abc","sdkSessionId":"def"}
```

---

## 8. User Experience

### Layout

```
+--------------------------------------------------+
| [Permission Banner - red, only when skip-perms]  |
+----------+---------------------------------------+
|          |  Session Title          [New Session]  |
| Sessions |---------------------------------------|
|          |                                       |
| > Sess 1 |  [Virtualized Message List]           |
|   Sess 2 |                                       |
|   Sess 3 |  User: /daily:plan                    |
|          |                                       |
|          |  Claude: Let me check your calendar... |
|          |  [Tool: list-events] [Running...]      |
|          |                                       |
|          |  Here are today's events:              |
|          |  ...                                   |
|          |                                       |
+----------+---------------------------------------|
|          |  [/ Command Palette (floating)]        |
|          |  /daily:plan  - Morning planning       |
|          |  /daily:tasks - Review open tasks       |
|          |---------------------------------------|
|          |  [Chat Input]          [Send]          |
+----------+---------------------------------------+
```

### Interaction Flows

1. **New Session:** Click "New Session" -> Choose permission mode -> Session created -> Chat ready
2. **Send Message:** Type in input -> Press Enter or click Send -> SSE stream begins -> Text + tool calls render progressively
3. **Slash Command:** Type `/` -> Floating dropdown appears -> Filter by typing -> Select with Enter or click -> Command inserted into input
4. **Tool Approval:** Tool call appears inline with "Approve" / "Deny" buttons -> Click to respond -> Stream continues
5. **Resume Session:** Click session in sidebar -> Messages load -> Chat continues with full context
6. **Permission Toggle:** When creating session, toggle "Skip Permissions" -> Red banner appears -> All tool calls auto-approved

---

## 9. Testing Strategy

### Unit Tests

- **Command Registry:** Test scanning, frontmatter parsing, cache invalidation
- **Session Store:** Test CRUD operations, file persistence, edge cases (empty store, corrupt JSON)
- **Stream Adapter:** Test SSE formatting, event serialization
- **Shared Types:** Test type guards and validation functions

### Integration Tests

- **Session Lifecycle:** Create -> Send message -> Receive stream -> Resume -> Delete
- **Command Endpoint:** Verify all commands discovered, correct metadata parsed
- **SSE Streaming:** Verify proper event format, connection handling, error propagation
- **Permission Modes:** Verify default mode blocks, skip mode auto-approves

### Component Tests

- **MessageList:** Test virtualization renders correct items, scrolls to bottom on new messages
- **CommandPalette:** Test filtering, keyboard navigation, selection
- **ToolCallCard:** Test expand/collapse, status icon rendering
- **ChatInput:** Test slash command detection, submit behavior
- **PermissionBanner:** Test shows/hides based on mode

### E2E Tests (Manual for v1)

- Full chat flow with streaming response
- Slash command auto-complete and execution
- Session create, switch, resume
- Permission toggle with tool approval

---

## 10. Performance Considerations

| Concern                                 | Mitigation                                                               |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Long message histories (1000+ messages) | TanStack Virtual renders only visible messages + 5 overscan              |
| Streaming markdown re-parsing           | Streamdown uses O(n) incremental parsing with memoized blocks            |
| SDK memory leak (400MB -> 4GB)          | Session timeout after 30 min inactive; SDK resume makes restart seamless |
| Large command registry (80+ commands)   | Cached on first load, invalidated only on explicit refresh               |
| SSE connection limits (6 per domain)    | Single SSE connection per active session; REST for everything else       |
| Initial page load                       | Vite code-splitting + lazy loading for non-critical components           |

---

## 11. Security Considerations

- **Localhost only:** Server binds to `localhost` by default, not `0.0.0.0`
- **Skip-permissions warning:** Persistent red banner when active; cannot be changed mid-session
- **Tool call visibility:** All tool calls logged and visible in the UI regardless of permission mode
- **No auth (v1):** Single-user, localhost assumption. API designed with `Authorization` header slot for future auth
- **Input sanitization:** All user input passes through the SDK which handles sanitization
- **No secrets in URL:** Session IDs are UUIDs, not predictable or sensitive
- **CORS:** Restricted to localhost origins in production

---

## 12. Documentation

- **README.md** in `gateway/` with setup, development, and production instructions
- **API documentation** generated from route definitions (or linked to this spec)
- Update `workspace/0-System/README.md` to reference the gateway as implemented (not "future")
- Update `.claude/rules/components.md` to add the gateway as a component

---

## 13. Implementation Phases

### Phase 1: Server Foundation

- Express server setup with TypeScript
- Session store (JSON persistence)
- Health endpoint
- Package.json with all dependencies
- `.env` with `GATEWAY_PORT=42420`
- npm scripts: `dev`, `build`, `start`

### Phase 2: SDK Integration & Chat Streaming

- Agent manager service with SDK `query()` integration
- SSE stream adapter
- `POST /api/sessions/:id/messages` endpoint with streaming
- Session creation with SDK session ID capture
- Basic error handling

### Phase 3: Frontend Foundation

- Vite + React 19 + TypeScript scaffold
- Tailwind + shadcn setup
- Basic layout (sidebar + main panel)
- Chat input component
- API client library (`src/client/lib/api.ts`)

### Phase 4: Chat UI with Streaming

- `useChatSession` hook wrapping Vercel AI SDK or custom SSE consumer
- MessageList with TanStack Virtual
- MessageItem with Streamdown markdown rendering
- Auto-scroll to bottom on new messages
- Loading/streaming state indicators

### Phase 5: Tool Calls & Permissions

- ToolCallCard component (expand/collapse, status icons)
- ToolApproval component (inline approve/deny buttons)
- Permission mode selection on session creation
- PermissionBanner component
- Approval/deny API endpoints

### Phase 6: Slash Commands

- Command registry service (scan + parse frontmatter)
- `GET /api/commands` endpoint
- CommandPalette component with cmdk
- Slash command detection in ChatInput
- `useCommands` hook with TanStack Query caching

### Phase 7: Session Management & Polish

- SessionSidebar component
- Session create/switch/resume/delete flows
- localStorage for active session persistence
- Session title auto-generation from first message
- Memory management (session health checks)

---

## 14. Open Questions

1. ~~**Vercel AI SDK compatibility**~~ (RESOLVED)
   **Answer:** Custom useChatSession hook with native EventSource
   **Rationale:** Our SSE format includes custom event types (tool_call_start, approval_required, etc.) that don't match the AI SDK's expected format. A lightweight custom hook gives full control over event parsing and state management.

   Original context preserved:
   - The AI SDK's `useChat` hook expects a specific server response format
   - Option A: Custom useChatSession hook (chosen)
   - Option B: Adapt server SSE to match AI SDK format

2. ~~**Tool approval flow**~~ (RESOLVED)
   **Answer:** Promise queue in canUseTool callback
   **Rationale:** The canUseTool callback returns a Promise that blocks the SDK agent loop. When approval is required, the server emits an `approval_required` SSE event, stores a pending Promise resolver, and waits. When the user clicks approve/deny via POST /api/sessions/:id/approve or /deny, the Promise resolves and the SDK continues.

   Original context preserved:
   - The Claude Agent SDK's `canUseTool` callback is synchronous in the agent loop
   - Option A: Promise-based queue (chosen)
   - Option B: Kill and restart agent with pre-approved tool list

3. ~~**SDK working directory**~~ (RESOLVED)
   **Answer:** Resolve to parent directory using `path.resolve(__dirname, '../../')`
   **Rationale:** The SDK needs cwd set to the vault root to load .claude/ configuration. Resolving to parent from gateway/ is straightforward and matches the single-package architecture.

   Original context preserved:
   - The SDK needs `cwd` set to the vault root (not `gateway/`)
   - Option A: Resolve to parent directory (chosen)
   - Option B: Require server to be started from vault root

---

## 15. References

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Claude Agent SDK Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK Plugins](https://platform.claude.com/docs/en/agent-sdk/plugins)
- [Claude Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [Vercel AI SDK](https://ai-sdk.dev/docs/introduction)
- [TanStack Virtual](https://tanstack.com/virtual/latest)
- [TanStack Query](https://tanstack.com/query/latest)
- [cmdk](https://cmdk.paco.me/)
- [Streamdown](https://github.com/vercel/streamdown)
- [shadcn/ui](https://ui.shadcn.com/)
- [Ideation Document](./01-ideation.md)
